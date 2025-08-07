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

// 여러 개의 발신 번호 관리
const TWILIO_CALLER_NUMBERS = process.env.TWILIO_CALLER_NUMBERS?.split(',').map((num) => num.trim()) || [];
if (TWILIO_CALLER_NUMBERS.length === 0) {
    logger.error('TWILIO_CALLER_NUMBERS environment variable is required (comma-separated)');
    process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

if (!OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

// 사용 중인 발신 번호 추적
const activeCallerNumbers = new Set<string>();

// 사용 가능한 발신 번호 선택 함수
function getAvailableCallerNumber(): string | null {
    for (const number of TWILIO_CALLER_NUMBERS) {
        if (!activeCallerNumbers.has(number)) {
            return number;
        }
    }
    return null; // 모든 번호가 사용 중
}

// 발신 번호 사용 시작
function startUsingCallerNumber(number: string): void {
    activeCallerNumbers.add(number);
    logger.info(
        `발신 번호 사용 시작: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
    );
}

// 발신 번호 사용 종료
function stopUsingCallerNumber(number: string): void {
    activeCallerNumbers.delete(number);
    logger.info(
        `발신 번호 사용 종료: ${number} (사용 중: ${activeCallerNumbers.size}/${TWILIO_CALLER_NUMBERS.length})`
    );
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

// CallSid와 사용 중인 발신 번호 매핑
export const callToCallerNumber = new Map<string, string>();

const twimlPath = join(__dirname, 'twiml.xml');
const twimlTemplate = readFileSync(twimlPath, 'utf-8');

const mainRouter = express.Router();

mainRouter.post('/twiml', (req: Request, res: Response) => {
    const callSid = req.body.CallSid;
    const elderIdParam = req.query.elderId || req.body.elderId;
    const sessionId = req.query.sessionId || req.body.sessionId;

    // 세션 ID를 통해 프롬프트 가져오기
    let prompt = req.query.prompt || req.body.prompt;

    logger.info(`TwiML 요청 디버그 - sessionId: ${sessionId}, prompt: ${prompt ? '있음' : '없음'}`);

    if (sessionId && !prompt) {
        prompt = (global as any).promptSessions?.get(sessionId);
        logger.info(`세션에서 프롬프트 가져오기 - sessionId: ${sessionId}, found: ${prompt ? '있음' : '없음'}`);
        if (prompt) {
            // 사용 후 세션에서 제거
            (global as any).promptSessions.delete(sessionId);
            logger.info(`세션에서 프롬프트 제거 완료`);
        }
    }

    if (!callSid) {
        res.status(400).send('CallSid is required');
        return;
    }
    if (!elderIdParam) {
        res.status(400).send('elderId is required');
        return;
    }

    const elderId = parseInt(elderIdParam, 10);
    if (isNaN(elderId)) {
        res.status(400).send('elderId must be a valid number');
        return;
    }

    logger.info(`TwiML 요청 - CallSid: ${callSid}, elderId: ${elderId}, prompt: ${prompt ? '있음' : '없음'}`);

    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = 'wss:';
    wsUrl.pathname = `/call/${callSid}/${elderId}`;

    // 프롬프트가 있으면 CallSid를 키로 저장
    if (prompt) {
        (global as any).promptSessions = (global as any).promptSessions || new Map();
        (global as any).promptSessions.set(callSid, prompt);
        logger.info(`CallSid로 프롬프트 저장 - callSid: ${callSid}, prompt 길이: ${prompt.length}`);
    }

    const wsUrlString = wsUrl.toString().replace(/&/g, '&amp;');
    logger.info(`생성된 WebSocket URL: ${wsUrlString}`);

    const twimlContent = twimlTemplate.replace('{{WS_URL}}', wsUrlString);
    res.set('Content-Type', 'text/xml; charset=utf-8').send(twimlContent);
});

interface CallRequest {
    elderId: number;
    phoneNumber?: string;
    prompt?: string;
}

mainRouter.post('/run', async (req: Request, res: Response) => {
    try {
        const { elderId, phoneNumber, prompt } = req.body;

        logger.info(
            `/run 요청 받음 - elderId: ${elderId}, phoneNumber: ${phoneNumber}, prompt: ${prompt ? '있음' : '없음'}`
        );
        if (prompt) {
            logger.info(`프롬프트 내용: ${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}`);
        }

        if (!elderId || typeof elderId !== 'number') {
            res.status(400).json({ success: false, error: 'elderId는 숫자여야 합니다' });
            return;
        }

        // 사용 가능한 발신 번호 선택
        const availableCallerNumber = getAvailableCallerNumber();
        if (!availableCallerNumber) {
            logger.error('모든 발신 번호가 사용 중입니다');
            res.status(503).json({
                success: false,
                error: '모든 발신 번호가 사용 중입니다. 잠시 후 다시 시도해주세요.',
                availableNumbers: TWILIO_CALLER_NUMBERS.length,
                activeCalls: activeCallerNumbers.size,
            });
            return;
        }

        // 프롬프트가 길 경우를 대비해 세션에 저장
        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        if (prompt) {
            // 프롬프트를 임시 세션에 저장 (실제로는 Redis나 DB 사용 권장)
            (global as any).promptSessions = (global as any).promptSessions || new Map();
            (global as any).promptSessions.set(sessionId, prompt);
            logger.info(`프롬프트 세션 저장 - sessionId: ${sessionId}, prompt 길이: ${prompt.length}`);
        }

        const twimlUrl = new URL(`${PUBLIC_URL}/call/twiml`);
        twimlUrl.searchParams.set('elderId', elderId.toString());
        if (prompt) {
            twimlUrl.searchParams.set('sessionId', sessionId);
        }

        logger.info(`전화 생성 파라미터:`, {
            url: twimlUrl.toString(),
            to: phoneNumber,
            from: availableCallerNumber,
        });

        const call = await twilioClient.calls.create({
            url: twimlUrl.toString(),
            method: 'POST',
            to: phoneNumber,
            from: availableCallerNumber,
        });

        // 발신 번호 사용 시작 및 CallSid와 매핑
        startUsingCallerNumber(availableCallerNumber);
        callToCallerNumber.set(call.sid, availableCallerNumber);

        logger.info(`전화 연결 시작 - CallSid: ${call.sid}, elderId: ${elderId}, 발신번호: ${availableCallerNumber}`);
        res.json({
            success: true,
            sid: call.sid,
            elderId,
            prompt: prompt || null,
            callerNumber: availableCallerNumber,
            availableNumbers: TWILIO_CALLER_NUMBERS.length - activeCallerNumbers.size,
        });
    } catch (err) {
        logger.error('전화 실패:', err);
        res.status(500).json({ success: false, error: String(err) });
    }
});

app.use('/call', mainRouter);

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
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
        const elderIdParam = parts[2];

        // CallSid를 통해 프롬프트 가져오기
        let prompt = undefined;
        if (sessionId) {
            prompt = (global as any).promptSessions?.get(sessionId);
            if (prompt) {
                // 사용 후 세션에서 제거
                (global as any).promptSessions.delete(sessionId);
                logger.info(`CallSid로 프롬프트 가져옴 - callSid: ${sessionId}, prompt 길이: ${prompt.length}`);
            } else {
                logger.info(`CallSid로 프롬프트를 찾을 수 없음 - callSid: ${sessionId}`);
            }
        }

        if (!elderIdParam) {
            logger.error(`elderId가 없습니다. sessionId: ${sessionId}`);
            ws.close();
            return;
        }

        // elderId를 number로 변환
        const elderId = parseInt(elderIdParam, 10);
        if (isNaN(elderId)) {
            logger.error(`elderId가 유효한 숫자가 아닙니다. sessionId: ${sessionId}, elderId: ${elderIdParam}`);
            ws.close();
            return;
        }

        logger.info(
            `WS 새 연결: type=${type}, sessionId=${sessionId}, elderId=${elderId}, prompt=${prompt ? '있음' : '없음'}`
        );

        if (type === 'call') {
            callConnections.set(sessionId, ws);

            // WebSocket 연결 종료 시 발신 번호 해제
            ws.on('close', () => {
                const callerNumber = callToCallerNumber.get(sessionId);
                if (callerNumber) {
                    stopUsingCallerNumber(callerNumber);
                    callToCallerNumber.delete(sessionId);
                    logger.info(`CallSid ${sessionId}의 발신 번호 ${callerNumber} 해제`);
                }
            });

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
    logger.info(`등록된 발신 번호: ${TWILIO_CALLER_NUMBERS.join(', ')}`);
    logger.info(`총 발신 번호 개수: ${TWILIO_CALLER_NUMBERS.length}`);
});
