import express, { Request, Response } from 'express';
import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import dotenv from 'dotenv';
import http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import cors from 'cors';
import { handleCallConnection, sendToWebhook } from './sessionManager';
import winston from 'winston';

dotenv.config();

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
    transports: [new winston.transports.Console()],
});

const PORT = parseInt(process.env.PORT || '8081', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_CALLER_NUMBER = process.env.TWILIO_CALLER_NUMBER!;
const TWILIO_RECIPIENT_NUMBER = process.env.TWILIO_RECIPIENT_NUMBER!;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export const callConnections = new Map<string, WebSocket>();
export const modelConnections = new Map<string, WebSocket>();
export const frontendConnections = new Map<string, WebSocket>();

const twimlPath = join(__dirname, 'twiml.xml');
const twimlTemplate = readFileSync(twimlPath, 'utf-8');

const mainRouter = express.Router();

mainRouter.post('/twiml', (req: Request, res: Response) => {
    const callSid = req.body.CallSid;
    const elderId = req.query.elderId as string;
    const prompt = req.query.prompt ? decodeURIComponent(req.query.prompt as string) : undefined;
    // server.ts에서 확인
    const twimlPath = join(__dirname, 'twiml.xml');
    console.log('📁 TwiML 파일 경로:', twimlPath);
    console.log('📄 TwiML 내용:', readFileSync(twimlPath, 'utf-8'));

    if (!callSid) {
        res.status(400).send('CallSid is required');
        return;
    }
    if (!elderId) {
        res.status(400).send('elderId is required');
        return;
    }

    logger.info(`TwiML 요청 - CallSid: ${callSid}, elderId: ${elderId}, prompt: ${prompt ? '있음' : '없음'}`);

    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = 'wss:';
    wsUrl.pathname = `/call/${callSid}/${elderId}`;
    if (prompt) wsUrl.searchParams.set('prompt', prompt);

    // & → &amp; 변환!
    const twimlContent = twimlTemplate.replace('{{WS_URL}}', wsUrl.toString().replace(/&/g, '&amp;'));
    res.set('Content-Type', 'text/xml; charset=utf-8').send(twimlContent);
});

interface CallRequest {
    elderId: string;
    phoneNumber?: string;
    prompt?: string;
}

mainRouter.post('/call', async (req: Request, res: Response) => {
    try {
        const { elderId, phoneNumber, prompt } = req.body;

        if (!elderId) {
            res.status(400).json({ success: false, error: 'elderId는 필수입니다' });
            return;
        }

        const twimlUrl = new URL(`${PUBLIC_URL}/call/twiml`);
        twimlUrl.searchParams.set('elderId', elderId);
        if (prompt) {
            twimlUrl.searchParams.set('prompt', encodeURIComponent(prompt));
        }

        logger.info(`🔍 생성된 TwiML URL: ${twimlUrl.toString()}`);
        logger.info(`🔍 PUBLIC_URL: ${PUBLIC_URL}`);
        logger.info(`🔍 전화 생성 파라미터:`, {
            url: twimlUrl.toString(),
            to: phoneNumber || TWILIO_RECIPIENT_NUMBER,
            from: TWILIO_CALLER_NUMBER,
        });

        const call = await twilioClient.calls.create({
            url: twimlUrl.toString(),
            to: phoneNumber || TWILIO_RECIPIENT_NUMBER,
            from: TWILIO_CALLER_NUMBER,
        });

        logger.info(`전화 연결 시작 - CallSid: ${call.sid}, elderId: ${elderId}`);
        res.json({ success: true, sid: call.sid, elderId, prompt: prompt || null });
    } catch (err) {
        logger.error('전화 실패:', err);
        res.status(500).json({ success: false, error: String(err) });
    }
});

app.use('/call', mainRouter);

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    logger.info(`🔌 새로운 WebSocket 연결 시도!`);
    logger.info(`🔍 Request URL: ${req.url}`);
    logger.info(`🔍 Request Headers:`, JSON.stringify(req.headers, null, 2));

    try {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const parts = url.pathname.split('/').filter(Boolean);

        if (parts.length < 2) {
            logger.error('WS 연결 URL이 올바르지 않습니다:', req.url);
            ws.close();
            return;
        }

        // parts[0] = 'call', parts[1] = callSid, parts[2] = elderId
        const type = parts[0];
        const sessionId = parts[1];
        const elderId = parts[2]; // 이렇게!
        const prompt = url.searchParams.get('prompt') ? decodeURIComponent(url.searchParams.get('prompt')!) : undefined;

        if (!elderId) {
            logger.error(`elderId가 없습니다. sessionId: ${sessionId}`);
            ws.close();
            return;
        }

        logger.info(
            `WS 새 연결: type=${type}, sessionId=${sessionId}, elderId=${elderId}, prompt=${prompt ? '있음' : '없음'}`
        );

        if (type === 'call') {
            callConnections.set(sessionId, ws);
            handleCallConnection(ws, OPENAI_API_KEY, WEBHOOK_URL, elderId, prompt, sessionId);
        } else if (type === 'logs') {
            frontendConnections.set(sessionId, ws);
        } else {
            logger.error(`알 수 없는 연결 type: ${type}`);
            ws.close();
        }
    } catch (err) {
        logger.error('WS connection 핸들러 오류:', err);
        ws.close();
    }
});

server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});
