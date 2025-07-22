import express from "express";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import cors from "cors";
import {
  handleCallConnection,
  handleFrontendConnection,
  sendToWebhook,
} from "./sessionManager";
import winston from "winston";

dotenv.config();

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple()
  ),
  transports: [
    new winston.transports.Console(),
    // 필요시 파일 저장도 추가 가능
    // new winston.transports.File({ filename: 'combined.log' })
  ]
});

const PORT = parseInt(process.env.PORT || "8081", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID!;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const TWILIO_CALLER_NUMBER = process.env.TWILIO_CALLER_NUMBER!;
const TWILIO_RECIPIENT_NUMBER = process.env.TWILIO_RECIPIENT_NUMBER!;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

if (!OPENAI_API_KEY) {
  logger.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json()); // JSON body 파싱
app.use(express.urlencoded({ extended: true })); // URL-encoded body 파싱 (하나만 사용)

//메모리에 웹소켓 연결을 저장하는 Map 객체
export const callConnections = new Map<string, WebSocket>(); //Twilio 연결
export const modelConnections = new Map<string, WebSocket>(); //OpenAI 연결
export const frontendConnections = new Map<string, WebSocket>(); //Frontend 연결
const twimlPath = join(__dirname, "twiml.xml");
const twimlTemplate = readFileSync(twimlPath, "utf-8");

const mainRouter = express.Router();

mainRouter.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

mainRouter.post("/twiml", (req,res) => {
  const callSid = req.body.CallSid; // Twilio 요청에서 CallSid 추출
  if (!callSid) {
    res.status(400).send("CallSid is required");
  }

  logger.info(`TwiML 요청 for CallSid: ${callSid}`);

  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  // WebSocket 경로에 CallSid를 포함시켜 어떤 통화에 대한 연결인지 식별
  wsUrl.pathname = `/call/${callSid}`;

  const twimlContent = twimlTemplate.replace("{{WS_URL}}", wsUrl.toString());
  res.type("text/xml").send(twimlContent);
});

mainRouter.get("/call", async (req, res) => {
  try {
    const call = await twilioClient.calls.create({
      url: `${PUBLIC_URL}/twiml`,
      to: TWILIO_RECIPIENT_NUMBER,
      from: TWILIO_CALLER_NUMBER,
    });

    logger.info(`전화 연결 시작, CallSid: ${call.sid}`);
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    logger.error("전화 실패:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// const callRouter = Router();

// mainRouter.get("/", async (req, res) => {
//   try {
//     const call = await twilioClient.calls.create({
//       url: `${PUBLIC_URL}/twiml`,
//       to: TWILIO_RECIPIENT_NUMBER,
//       from: TWILIO_CALLER_NUMBER,
//     });
//
//     logger.info("전화 연결 시작:", call.sid);
//     res.json({ success: true, sid: call.sid });
//   } catch (err) {
//     logger.error("전화 실패:", err);
//     res.status(500).json({ success: false, error: String(err) });
//   }
// });
app.use("/call", mainRouter);

// 웹훅 전송 테스트 엔드포인트
mainRouter.get("/test-webhook", async (req, res) => {
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
  const testSessionId = "test-session-12345"; // 테스트용 세션 ID

  try {
    await sendToWebhook(testData, WEBHOOK_URL, testSessionId);
    logger.info("테스트 웹훅 전송 완료");
    res.json({ 
      success: true, 
      message: "웹훅 전송 완료! Webhook.site에서 확인해보세요.",
      webhookUrl: WEBHOOK_URL 
    });
  } catch (error) {
    logger.error("테스트 웹훅 전송 실패:", error);
    res.status(500).json({ 
      success: false, 
      error: String(error) 
    });
  }
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    // 예: /call/CA123... 또는 /logs/CA123...
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
      logger.error("WS 연결 URL이 올바르지 않습니다 (세션 ID 누락):", req.url);
      ws.close();
      return;
    }

    const type = parts[0];      // "call" 또는 "logs"
    const sessionId = parts[1]; // Twilio의 CallSid

    logger.info(`WS 새 연결: type=${type}, sessionId=${sessionId}`);

    if (type === "call") {
      callConnections.set(sessionId, ws); // 메모리의 연결 맵에 추가
      handleCallConnection(ws, sessionId, OPENAI_API_KEY, WEBHOOK_URL);
    } else if (type === "logs") {
      frontendConnections.set(sessionId, ws); // 모니터링 연결도 세션 ID 기반으로 관리
      handleFrontendConnection(ws, sessionId);
    } else {
      logger.error(`WS 알 수 없는 연결 type: ${type}`);
      ws.close();
    }
  } catch (err) {
    logger.error("WS connection 핸들러에서 예외 발생:", err);
    ws.close();
  }
});

server.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});
