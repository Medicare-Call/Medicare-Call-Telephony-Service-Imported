"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const twilio_1 = __importDefault(require("twilio"));
const ws_1 = require("ws");
const dotenv_1 = __importDefault(require("dotenv"));
const http_1 = __importDefault(require("http"));
const fs_1 = require("fs");
const path_1 = require("path");
const cors_1 = __importDefault(require("cors"));
const sessionManager_1 = require("./sessionManager");
const winston_1 = __importDefault(require("winston"));
dotenv_1.default.config();
const logger = winston_1.default.createLogger({
    level: "info",
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.simple()),
    transports: [
        new winston_1.default.transports.Console(),
        // 필요시 파일 저장도 추가 가능
        // new winston.transports.File({ filename: 'combined.log' })
    ]
});
const PORT = parseInt(process.env.PORT || "8081", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_CALLER_NUMBER = process.env.TWILIO_CALLER_NUMBER;
const TWILIO_RECIPIENT_NUMBER = process.env.TWILIO_RECIPIENT_NUMBER;
const twilioClient = (0, twilio_1.default)(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
if (!OPENAI_API_KEY) {
    logger.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
}
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
app.use(express_1.default.urlencoded({ extended: false }));
const twimlPath = (0, path_1.join)(__dirname, "twiml.xml");
const twimlTemplate = (0, fs_1.readFileSync)(twimlPath, "utf-8");
app.get("/public-url", (req, res) => {
    res.json({ publicUrl: PUBLIC_URL });
});
app.all("/twiml", (req, res) => {
    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = `/call`;
    const twimlContent = twimlTemplate.replace("{{WS_URL}}", wsUrl.toString());
    res.type("text/xml").send(twimlContent);
});
let currentCall = null;
let currentLogs = null;
wss.on("connection", (ws, req) => {
    try {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 1) {
            logger.error("WS 연결 URL이 올바르지 않습니다:", req.url);
            ws.close();
            return;
        }
        const type = parts[0];
        logger.info(`WS 새 연결: type=${type}, url=${req.url}`);
        if (type === "call") {
            if (currentCall) {
                logger.info("WS 기존 call 연결 종료");
                currentCall.close();
            }
            currentCall = ws;
            try {
                (0, sessionManager_1.handleCallConnection)(currentCall, OPENAI_API_KEY, WEBHOOK_URL);
                logger.info("WS handleCallConnection 호출 완료");
            }
            catch (err) {
                logger.error("WS handleCallConnection 중 에러:", err);
            }
        }
        else if (type === "logs") {
            if (currentLogs) {
                logger.info("WS 기존 logs 연결 종료");
                currentLogs.close();
            }
            currentLogs = ws;
            try {
                (0, sessionManager_1.handleFrontendConnection)(currentLogs);
                logger.info("WS handleFrontendConnection 호출 완료");
            }
            catch (err) {
                logger.error("WS handleFrontendConnection 중 에러:", err);
            }
        }
        else {
            logger.error(`WS 알 수 없는 연결 type: ${type}`);
            ws.close();
        }
        ws.on("error", (err) => {
            logger.error(`WS WebSocket 에러(type=${type}):`, err);
        });
        ws.on("close", (code, reason) => {
            logger.info(`WS WebSocket 연결 종료(type=${type}), code=${code}, reason=${reason}`);
        });
    }
    catch (err) {
        logger.error("WS connection 핸들러에서 예외 발생:", err);
        ws.close();
    }
});
app.get("/call", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const call = yield twilioClient.calls.create({
            url: `${PUBLIC_URL}/twiml`,
            to: TWILIO_RECIPIENT_NUMBER,
            from: TWILIO_CALLER_NUMBER,
        });
        logger.info("전화 연결 시작:", call.sid);
        res.json({ success: true, sid: call.sid });
    }
    catch (err) {
        logger.error("전화 실패:", err);
        res.status(500).json({ success: false, error: String(err) });
    }
}));
// 웹훅 전송 테스트 엔드포인트
app.get("/test-webhook", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const testData = {
        mindStatus: "GOOD",
        sleepTimes: 7,
        healthStatus: "NORMAL",
        summary: "테스트 전송입니다.",
        content: [
            {
                is_elderly: false,
                conversation: "어르신, 어젯밤 잠은 좀 잘 주무셨어요? 몇 시간 정도 주무셨을까요?"
            },
            {
                is_elderly: true,
                conversation: "네, 한 6시간 정도 잤어요."
            },
            {
                is_elderly: false,
                conversation: "이것은 테스트 메시지입니다."
            }
        ]
    };
    try {
        yield (0, sessionManager_1.sendToWebhook)(testData);
        logger.info("테스트 웹훅 전송 완료");
        res.json({
            success: true,
            message: "웹훅 전송 완료! Webhook.site에서 확인해보세요.",
            webhookUrl: WEBHOOK_URL
        });
    }
    catch (error) {
        logger.error("테스트 웹훅 전송 실패:", error);
        res.status(500).json({
            success: false,
            error: String(error)
        });
    }
}));
server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});
