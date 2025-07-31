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
exports.frontendConnections = exports.modelConnections = exports.callConnections = void 0;
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
    transports: [new winston_1.default.transports.Console()]
});
const PORT = parseInt(process.env.PORT || "8081", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_CALLER_NUMBERS = process.env.TWILIO_CALLER_NUMBERS;
const TWILIO_RECIPIENT_NUMBER = process.env.TWILIO_RECIPIENT_NUMBER;
const twilioClient = (0, twilio_1.default)(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
if (!OPENAI_API_KEY) {
    logger.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
}
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
exports.callConnections = new Map();
exports.modelConnections = new Map();
exports.frontendConnections = new Map();
const twimlPath = (0, path_1.join)(__dirname, "twiml.xml");
const twimlTemplate = (0, fs_1.readFileSync)(twimlPath, "utf-8");
const mainRouter = express_1.default.Router();
mainRouter.post("/twiml", (req, res) => {
    const callSid = req.body.CallSid;
    const elderId = req.query.elderId;
    const prompt = req.query.prompt ? decodeURIComponent(req.query.prompt) : undefined;
    if (!callSid)
        res.status(400).send("CallSid is required");
    if (!elderId)
        res.status(400).send("elderId is required");
    logger.info(`TwiML 요청 - CallSid: ${callSid}, elderId: ${elderId}, prompt: ${prompt ? "있음" : "없음"}`);
    const wsUrl = new URL(PUBLIC_URL);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = `/call/${callSid}`;
    wsUrl.searchParams.set("elderId", elderId);
    if (prompt)
        wsUrl.searchParams.set("prompt", encodeURIComponent(prompt));
    const twimlContent = twimlTemplate.replace("{{WS_URL}}", wsUrl.toString());
    res.type("text/xml").send(twimlContent);
});
mainRouter.post("/call", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { elderId, phoneNumber, prompt } = req.body;
        if (!elderId) {
            res.status(400).json({ success: false, error: "elderId는 필수입니다" });
        }
        const twimlUrl = new URL(`${PUBLIC_URL}/call/twiml`);
        twimlUrl.searchParams.set("elderId", elderId);
        if (prompt) {
            twimlUrl.searchParams.set("prompt", encodeURIComponent(prompt));
        }
        const call = yield twilioClient.calls.create({
            url: twimlUrl.toString(),
            to: phoneNumber || TWILIO_RECIPIENT_NUMBER,
            from: TWILIO_CALLER_NUMBERS,
        });
        logger.info(`전화 연결 시작 - CallSid: ${call.sid}, elderId: ${elderId}`);
        res.json({ success: true, sid: call.sid, elderId, prompt: prompt || null });
    }
    catch (err) {
        logger.error("전화 실패:", err);
        res.status(500).json({ success: false, error: String(err) });
    }
}));
app.use("/call", mainRouter);
wss.on("connection", (ws, req) => {
    try {
        const url = new URL(req.url || "", `http://${req.headers.host}`);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 2) {
            logger.error("WS 연결 URL이 올바르지 않습니다:", req.url);
            ws.close();
            return;
        }
        const type = parts[0];
        const sessionId = parts[1];
        const elderId = url.searchParams.get("elderId");
        const prompt = url.searchParams.get("prompt")
            ? decodeURIComponent(url.searchParams.get("prompt"))
            : undefined;
        if (!elderId) {
            logger.error(`elderId가 없습니다. sessionId: ${sessionId}`);
            ws.close();
            return;
        }
        logger.info(`WS 새 연결: type=${type}, sessionId=${sessionId}, elderId=${elderId}, prompt=${prompt ? "있음" : "없음"}`);
        if (type === "call") {
            exports.callConnections.set(sessionId, ws);
            (0, sessionManager_1.handleCallConnection)(ws, OPENAI_API_KEY, WEBHOOK_URL, elderId, prompt, sessionId);
        }
        else if (type === "logs") {
            exports.frontendConnections.set(sessionId, ws);
        }
        else {
            logger.error(`알 수 없는 연결 type: ${type}`);
            ws.close();
        }
    }
    catch (err) {
        logger.error("WS connection 핸들러 오류:", err);
        ws.close();
    }
});
server.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});
