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
exports.sendToWebhook = sendToWebhook;
exports.sendTestWebhook = sendTestWebhook;
exports.handleCallConnection = handleCallConnection;
exports.handleFrontendConnection = handleFrontendConnection;
const ws_1 = require("ws");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: "info",
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.simple()),
    transports: [
        new winston_1.default.transports.Console(),
        // 필요시 파일 저장도 추가 가능
        // new winston.transports.File({ filename: 'combined.log' })
    ]
});
const INITIAL_PROMPT = `
당신은 고령자를 위한 따뜻하고 친절한 AI 전화 상담원입니다.

**역할**: 고령 어르신과 자연스러운 전화 상담을 진행하세요.

**대화 목표**: 다음 3가지 주제에 대해 자연스럽게 대화하세요
1. 수면 상태 (어젯밤 잠은 몇시간 정도 주무셨는지)
2. 기분 상태 (오늘 하루 기분이 어떠신지)  
3. 건강 상태 (몸 어디 편찮은 곳은 없는지)

**대화 스타일**:
- 매번 어르신의 답변에 먼저 공감하고 적절히 반응하세요
- 그 다음에 자연스럽게 다음 질문으로 이어가세요
- 건강 문제가 있으면 간단한 조언을 해주세요
- 따뜻하고 친근한 톤으로 대화하세요

**중요**: 사용자의 실제 응답을 정확히 듣고 그 내용에 맞게 반응하세요. 아래 예시는 대화 흐름 참고용이며, 실제 대화에서는 사용자가 말한 구체적인 내용에 맞춰 대화하세요.

**대화 흐름 예시**:
AI: "안녕하세요, 어르신! 오늘 간단한 안부 인사를 드리려고 전화드렸어요."
어르신: [인사 응답 - 예: "네 안녕하세요", "네 그래요", "안녕하세요" 등]
AI: [간단한 응답 확인 후 바로 첫 번째 질문] "어르신 어젯밤 잠은 몇시간 정도 주무셨어요?"
어르신: [수면 시간 응답 - 예: "6시간", "잘 못잤어요", "푹 잤어요" 등]
AI: [수면 응답에 대한 적절한 공감] + "그럼 오늘 하루 기분은 어떠셨어요?"
어르신: [기분 상태 응답 - 예: "좋았어요", "우울해요", "그냥 그래요" 등]  
AI: [기분 응답에 대한 적절한 공감] + "혹시 몸 어디 편찮으신 데는 없으세요?"
어르신: [건강 상태 응답 - 예: "무릎 아파요", "감기 기운", "괜찮아요" 등]
AI: [사용자가 말한 구체적인 건강 상태에 맞는 조언과 공감] + 따뜻한 마무리 인사

**핵심 원칙**: 
- 어르신이 실제로 말씀하신 내용(수면시간, 기분상태, 건강문제)을 정확히 반영해서 대화하세요
- 예시의 구체적인 내용을 그대로 사용하지 말고, 사용자의 실제 답변에 맞춰 반응하세요
- 3가지 주제를 모두 다룬 후 따뜻하게 마무리하세요

지금 첫 번째 인사를 해주세요.
`;
let session = {};
// 최종 응답 JSON을 웹훅 URL로 전송하는 함수
function sendToWebhook(data) {
    return __awaiter(this, void 0, void 0, function* () {
        const webhookUrl = session.webhookUrl || process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            logger.info("No webhook URL configured");
            return;
        }
        // conversationHistory 배열을 content 객체로 감싸기
        const formattedData = {
            content: data
        };
        logger.info("🌐 Sending to webhook:", webhookUrl);
        logger.info("📦 Webhook data:", JSON.stringify(formattedData, null, 2));
        try {
            const response = yield fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formattedData),
            });
            if (response.ok) {
                logger.info('✅ Successfully sent data to webhook:', webhookUrl);
            }
            else {
                logger.error('❌ Failed to send data to webhook:', response.status, response.statusText);
            }
        }
        catch (error) {
            logger.error('❌ Error sending data to webhook:', error);
        }
    });
}
// 테스트용 웹훅 전송 함수
function sendTestWebhook(webhookUrl, testData) {
    return __awaiter(this, void 0, void 0, function* () {
        const targetUrl = webhookUrl || session.webhookUrl || process.env.WEBHOOK_URL;
        if (!targetUrl) {
            logger.info("❌ No webhook URL provided for test");
            return { success: false, error: "No webhook URL configured" };
        }
        // 기본 테스트 데이터
        const defaultTestData = [
            {
                "is_elderly": false,
                "conversation": "안녕하세요, 어르신! 오늘 간단한 안부 인사를 드리려고 전화드렸어요."
            },
            {
                "is_elderly": true,
                "conversation": "네 안녕하세요"
            },
            {
                "is_elderly": false,
                "conversation": "어르신 어젯밤 잠은 몇시간 정도 주무셨어요?"
            },
            {
                "is_elderly": true,
                "conversation": "음 7시간정도 잤네요"
            },
            {
                "is_elderly": false,
                "conversation": "아 7시간정도 잘 주무셨군요! 충분히 주무신 것 같아서 다행이네요. 그럼 오늘 하루 기분은 어떠셨어요?"
            },
            {
                "is_elderly": true,
                "conversation": "오늘 기분이 좋았어요"
            },
            {
                "is_elderly": false,
                "conversation": "기분 좋으시다니 정말 다행이에요! 좋은 일이 있으셨나봐요. 그런데 혹시 몸 어디 편찮으신 데는 없으세요?"
            },
            {
                "is_elderly": true,
                "conversation": "무릎이 좀 아파요"
            },
            {
                "is_elderly": false,
                "conversation": "아 무릎이 아프시는군요. 날씨가 추워져서 그럴 수도 있어요. 따뜻하게 찜질해주시고 무리하지 마세요. 네 알겠습니다 내일또 연락드릴게요 좋은하루 보내세요!"
            }
        ];
        const dataToSend = testData || defaultTestData;
        // conversationHistory 배열을 content 객체로 감싸기
        const formattedData = {
            content: dataToSend,
            test: true, // 테스트 데이터임을 표시
            timestamp: new Date().toISOString()
        };
        logger.info("🧪 Sending TEST webhook to:", targetUrl);
        logger.info("📦 Test webhook data:", JSON.stringify(formattedData, null, 2));
        try {
            const response = yield fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formattedData),
            });
            if (response.ok) {
                logger.info('✅ Successfully sent TEST data to webhook:', targetUrl);
                return { success: true, message: "Test webhook sent successfully" };
            }
            else {
                logger.error('❌ Failed to send TEST data to webhook:', response.status, response.statusText);
                return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
            }
        }
        catch (error) {
            logger.error('❌ Error sending TEST data to webhook:', error);
            return { success: false, error: error.message };
        }
    });
}
// AI 응답에서 최종 JSON을 감지하고 추출하는 함수
function extractFinalJson(text) {
    logger.info("🔍 Trying to extract JSON from text length:", text.length);
    try {
        // 더 유연한 JSON 패턴들을 순서대로 시도
        const patterns = [
            // 원래 패턴 (모든 필드 포함)
            /\{[\s\S]*"mindStatus"[\s\S]*"sleepTimes"[\s\S]*"healthStatus"[\s\S]*"summary"[\s\S]*"content"[\s\S]*\}/,
            // mindStatus만 포함된 JSON
            /\{[\s\S]*"mindStatus"[\s\S]*\}/,
            // 아무 JSON이나
            /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/
        ];
        for (let i = 0; i < patterns.length; i++) {
            const pattern = patterns[i];
            const match = text.match(pattern);
            if (match) {
                logger.info(`🎯 Pattern ${i + 1} matched:`, match[0].substring(0, 200) + "...");
                try {
                    const jsonStr = match[0];
                    const parsed = JSON.parse(jsonStr);
                    // mindStatus, sleepTimes, healthStatus 중 하나라도 있으면 유효한 JSON으로 간주
                    if (parsed.mindStatus || parsed.sleepTimes !== undefined || parsed.healthStatus) {
                        logger.info("✅ Valid conversation JSON found");
                        return parsed;
                    }
                    else {
                        logger.info("❌ JSON found but missing required fields");
                    }
                }
                catch (parseError) {
                    logger.info(`❌ Pattern ${i + 1} matched but JSON parsing failed:`, parseError);
                }
            }
        }
        logger.info("❌ No valid JSON pattern found");
        return null;
    }
    catch (error) {
        logger.error('❌ Error in extractFinalJson:', error);
        return null;
    }
}
function handleCallConnection(ws, openAIApiKey, webhookUrl) {
    try {
        cleanupConnection(session.twilioConn);
        session.twilioConn = ws;
        session.openAIApiKey = openAIApiKey;
        session.webhookUrl = webhookUrl;
        session.conversationStep = 0; // 대화 시작 전
        // conversationHistory 초기화
        session.conversationHistory = [];
        logger.info("Call connection established - initialized empty conversationHistory");
        ws.on("message", (data) => {
            try {
                handleTwilioMessage(data);
            }
            catch (err) {
                logger.error("[handleCallConnection] handleTwilioMessage 에러:", err);
            }
        });
        ws.on("error", (err) => {
            logger.error("[handleCallConnection] Twilio WebSocket 에러:", err);
            ws.close();
        });
        ws.on("close", () => {
            var _a;
            logger.info("Twilio WebSocket connection closed");
            logger.info("최종 대화 기록 개수:", ((_a = session.conversationHistory) === null || _a === void 0 ? void 0 : _a.length) || 0);
            try {
                cleanupConnection(session.modelConn);
                cleanupConnection(session.twilioConn);
                session.twilioConn = undefined;
                session.modelConn = undefined;
                session.streamSid = undefined;
                session.lastAssistantItem = undefined;
                session.responseStartTimestamp = undefined;
                session.latestMediaTimestamp = undefined;
                if (!session.frontendConn) {
                    logger.info("All connections closed - resetting session");
                    session = {};
                }
            }
            catch (err) {
                logger.error("[handleCallConnection] close 핸들러 에러:", err);
            }
        });
    }
    catch (err) {
        logger.error("[handleCallConnection] 전체 예외:", err);
        ws.close();
    }
}
function handleFrontendConnection(ws) {
    try {
        cleanupConnection(session.frontendConn);
        session.frontendConn = ws;
        ws.on("message", (data) => {
            try {
                handleFrontendMessage(data);
            }
            catch (err) {
                logger.error("[handleFrontendConnection] handleFrontendMessage 에러:", err);
            }
        });
        ws.on("close", () => {
            try {
                cleanupConnection(session.frontendConn);
                session.frontendConn = undefined;
                if (!session.twilioConn && !session.modelConn)
                    session = {};
            }
            catch (err) {
                logger.error("[handleFrontendConnection] close 핸들러 에러:", err);
            }
        });
    }
    catch (err) {
        logger.error("[handleFrontendConnection] 전체 예외:", err);
        ws.close();
    }
}
function handleTwilioMessage(data) {
    let msg;
    try {
        msg = parseMessage(data);
    }
    catch (err) {
        logger.error("[handleTwilioMessage] parseMessage 에러:", err);
        return;
    }
    if (!msg)
        return;
    // media 이벤트가 아닌 경우만 로그 출력
    if (msg.event !== "media") {
        logger.info("Twilio message received:", msg.event);
    }
    try {
        switch (msg.event) {
            case "start":
                logger.info("Call started, streamSid:", msg.start.streamSid);
                session.streamSid = msg.start.streamSid;
                session.latestMediaTimestamp = 0;
                session.lastAssistantItem = undefined;
                session.responseStartTimestamp = undefined;
                tryConnectModel();
                break;
            case "media":
                session.latestMediaTimestamp = msg.media.timestamp;
                if (isOpen(session.modelConn)) {
                    jsonSend(session.modelConn, {
                        type: "input_audio_buffer.append",
                        audio: msg.media.payload,
                    });
                }
                break;
            case "stop":
                logger.info("Call ended - Twilio stop event received");
                closeAllConnections();
                break;
            case "close":
                logger.info("Call ended - Twilio close event received");
                closeAllConnections();
                break;
            default:
                logger.warn("[handleTwilioMessage] 알 수 없는 Twilio 이벤트:", msg.event);
        }
    }
    catch (err) {
        logger.error("[handleTwilioMessage] switch-case 처리 중 에러:", err);
    }
}
function handleFrontendMessage(data) {
    let msg;
    try {
        msg = parseMessage(data);
    }
    catch (err) {
        logger.error("[handleFrontendMessage] parseMessage 에러:", err);
        return;
    }
    if (!msg)
        return;
    // 웹훅 테스트 요청 처리
    if (msg.type === "webhook.test") {
        logger.info("Webhook test requested from frontend");
        sendTestWebhook(msg.webhookUrl, msg.testData)
            .then(result => {
            if (session.frontendConn) {
                jsonSend(session.frontendConn, {
                    type: "webhook.test.result",
                    success: result.success,
                    message: result.message,
                    error: result.error
                });
            }
        })
            .catch(error => {
            logger.error("[handleFrontendMessage] webhook test 에러:", error);
            if (session.frontendConn) {
                jsonSend(session.frontendConn, {
                    type: "webhook.test.result",
                    success: false,
                    error: error.message
                });
            }
        });
        return;
    }
    try {
        if (isOpen(session.modelConn)) {
            jsonSend(session.modelConn, msg);
        }
        if (msg.type === "session.update") {
            session.saved_config = msg.session;
        }
    }
    catch (err) {
        logger.error("[handleFrontendMessage] modelConn 전송/세션 저장 에러:", err);
    }
}
function tryConnectModel() {
    try {
        if (!session.twilioConn || !session.streamSid || !session.openAIApiKey)
            return;
        if (isOpen(session.modelConn))
            return;
        logger.info("🔗 Connecting to OpenAI model...");
        session.modelConn = new ws_1.WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
            headers: {
                Authorization: `Bearer ${session.openAIApiKey}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });
        session.modelConn.on("open", () => {
            try {
                logger.info("✅ OpenAI WebSocket connected");
                const config = session.saved_config || {};
                const sessionConfig = {
                    type: "session.update",
                    session: Object.assign({ modalities: ["text", "audio"], turn_detection: { type: "server_vad" }, voice: "ash", input_audio_transcription: { model: "whisper-1" }, input_audio_format: "g711_ulaw", output_audio_format: "g711_ulaw" }, config),
                };
                logger.info("📝 Sending session config:", JSON.stringify(sessionConfig, null, 2));
                jsonSend(session.modelConn, sessionConfig);
                logger.info("📝 Sending initial prompt...");
                sendUserMessage(INITIAL_PROMPT);
            }
            catch (err) {
                logger.error("[tryConnectModel] on open 핸들러 에러:", err);
            }
        });
        session.modelConn.on("message", (data) => {
            try {
                const dataStr = data.toString();
                const messageType = JSON.parse(dataStr).type;
                // 로그에서 제외할 메시지 타입들
                const excludedTypes = [
                    "response.audio.delta",
                    "input_audio_buffer",
                    "conversation.item.created",
                    "response.created",
                    "response.done",
                    "rate_limits.updated",
                    "response.output_item.added",
                    "response.output_item.done",
                    "response.content_part.added",
                    "response.audio_transcript.delta",
                    "conversation.item.input_audio_transcription.delta"
                ];
                const shouldLog = !excludedTypes.some(type => messageType.includes(type));
                if (shouldLog) {
                    logger.info("📨 OpenAI message received:", messageType, dataStr.substring(0, 200) + "...");
                }
                handleModelMessage(data);
            }
            catch (err) {
                logger.error("[tryConnectModel] on message 핸들러 에러:", err);
            }
        });
        session.modelConn.on("error", (error) => {
            logger.error("[tryConnectModel] OpenAI WebSocket 에러:", error);
            closeModel();
        });
        session.modelConn.on("close", (code, reason) => {
            logger.info("🔌 OpenAI WebSocket closed:", code, reason.toString());
            closeModel();
        });
    }
    catch (err) {
        logger.error("[tryConnectModel] 전체 예외:", err);
    }
}
function sendUserMessage(text) {
    try {
        logger.info("📤 Sending user message:", text.substring(0, 100) + "...");
        if (!isOpen(session.modelConn)) {
            logger.error("[sendUserMessage] modelConn 미연결, 메시지 전송 불가");
            return;
        }
        /* ① user 메시지 생성  */
        const userMessage = {
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "user",
                content: [
                    {
                        type: "input_text", // ← 'text'가 아니라 반드시 'input_text'
                        text,
                    },
                ],
            },
        };
        logger.info("📝 Sending conversation item:", JSON.stringify(userMessage, null, 2));
        jsonSend(session.modelConn, userMessage);
        /* ② assistant 응답 트리거  */
        const responseCreate = { type: "response.create" };
        logger.info("🎯 Triggering response creation:", JSON.stringify(responseCreate, null, 2));
        jsonSend(session.modelConn, responseCreate);
    }
    catch (err) {
        logger.error("[sendUserMessage] 전체 예외:", err);
    }
}
function handleModelMessage(data) {
    let event;
    try {
        event = parseMessage(data);
    }
    catch (err) {
        logger.error("[handleModelMessage] parseMessage 에러:", err);
        return;
    }
    if (!event)
        return;
    try {
        jsonSend(session.frontendConn, event);
    }
    catch (err) {
        logger.error("[handleModelMessage] frontendConn 전송 에러:", err);
    }
    try {
        switch (event.type) {
            case "input_audio_buffer.speech_started":
                handleTruncation();
                break;
            case "response.audio.delta":
                if (session.twilioConn && session.streamSid) {
                    if (session.responseStartTimestamp === undefined) {
                        session.responseStartTimestamp = session.latestMediaTimestamp || 0;
                    }
                    if (event.item_id)
                        session.lastAssistantItem = event.item_id;
                    jsonSend(session.twilioConn, {
                        event: "media",
                        streamSid: session.streamSid,
                        media: { payload: event.delta },
                    });
                    jsonSend(session.twilioConn, {
                        event: "mark",
                        streamSid: session.streamSid,
                    });
                }
                break;
            case "response.output_item.done": {
                logger.info("디버그: response.output_item.done 수신");
                const { item } = event;
                logger.info("디버그: item type:", item === null || item === void 0 ? void 0 : item.type, "role:", item === null || item === void 0 ? void 0 : item.role);
                if (item.type === "message" && item.role === "assistant") {
                    logger.info("디버그: assistant 메시지 감지");
                    // AI의 실제 응답을 conversationHistory에 저장
                    const content = item.content;
                    logger.info("디버그: content:", content);
                    if (content && Array.isArray(content)) {
                        logger.info("디버그: content 배열 길이:", content.length);
                        for (const contentItem of content) {
                            logger.info("디버그: contentItem type:", contentItem.type, "text:", !!contentItem.text, "transcript:", !!contentItem.transcript);
                            // text 타입이거나 audio 타입의 transcript가 있는 경우 저장
                            let aiResponse = null;
                            if (contentItem.type === "text" && contentItem.text) {
                                aiResponse = contentItem.text;
                            }
                            else if (contentItem.type === "audio" && contentItem.transcript) {
                                aiResponse = contentItem.transcript;
                            }
                            if (aiResponse) {
                                logger.info("AI 응답:", aiResponse);
                                // conversationHistory 초기화 체크
                                if (!session.conversationHistory) {
                                    session.conversationHistory = [];
                                }
                                // AI의 실제 응답을 저장
                                session.conversationHistory.push({
                                    is_elderly: false,
                                    conversation: aiResponse
                                });
                                logger.info(`대화 기록 업데이트 - 총 ${session.conversationHistory.length}개`);
                            }
                        }
                    }
                    else {
                        logger.info("content가 배열이 아니거나 null");
                    }
                }
                else {
                    logger.info("유효하지 않은 assistant 메시지");
                }
                break;
            }
            case "conversation.item.input_audio_transcription.completed":
                // 사용자 음성 인식 완료 시 로깅
                if (event.transcript) {
                    logger.info("음성 인식 완료:", event.transcript);
                    logger.info("사용자 발화:", event.transcript);
                    // 사용자 응답을 conversationHistory에 저장
                    if (!session.conversationHistory) {
                        session.conversationHistory = [];
                    }
                    session.conversationHistory.push({
                        is_elderly: true,
                        conversation: event.transcript
                    });
                    logger.info(`사용자 응답 저장 완료 - 총 대화 ${session.conversationHistory.length}개`);
                }
                else {
                    logger.info("빈 음성 인식 결과");
                }
                break;
            default:
                // 기타 이벤트는 무시
                break;
        }
    }
    catch (err) {
        logger.error("[handleModelMessage] switch-case 처리 중 에러:", err);
    }
}
function handleTruncation() {
    if (!session.lastAssistantItem ||
        session.responseStartTimestamp === undefined)
        return;
    const elapsedMs = (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
    const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, {
            type: "conversation.item.truncate",
            item_id: session.lastAssistantItem,
            content_index: 0,
            audio_end_ms,
        });
    }
    if (session.twilioConn && session.streamSid) {
        jsonSend(session.twilioConn, {
            event: "clear",
            streamSid: session.streamSid,
        });
    }
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
}
function closeModel() {
    cleanupConnection(session.modelConn);
    session.modelConn = undefined;
    if (!session.twilioConn && !session.frontendConn)
        session = {};
}
function closeAllConnections() {
    var _a;
    logger.info("Connection closing...");
    logger.info("   - conversationHistory length:", ((_a = session.conversationHistory) === null || _a === void 0 ? void 0 : _a.length) || 0);
    logger.info("   - conversationStep:", session.conversationStep);
    logger.info("   - webhookUrl:", session.webhookUrl || process.env.WEBHOOK_URL);
    // 통화 종료 시 conversationHistory가 있으면 웹훅 전송
    const sendWebhookPromise = () => __awaiter(this, void 0, void 0, function* () {
        if (session.conversationHistory && session.conversationHistory.length > 0 && (session.webhookUrl || process.env.WEBHOOK_URL)) {
            logger.info("📤 Sending conversation history on connection close");
            try {
                yield sendToWebhook(session.conversationHistory);
                logger.info("✅ Webhook sent successfully before cleanup");
            }
            catch (error) {
                logger.error("❌ Error sending webhook before cleanup:", error);
            }
        }
        else {
            logger.info("❌ Not sending webhook on close:");
            if (!session.conversationHistory || session.conversationHistory.length === 0) {
                logger.info("   - No conversation history");
            }
            if (!session.webhookUrl && !process.env.WEBHOOK_URL) {
                logger.info("   - No webhook URL");
            }
        }
    });
    // 웹훅 전송을 기다린 후 세션 정리
    sendWebhookPromise().finally(() => {
        if (session.twilioConn) {
            session.twilioConn.close();
            session.twilioConn = undefined;
        }
        if (session.modelConn) {
            session.modelConn.close();
            session.modelConn = undefined;
        }
        if (session.frontendConn) {
            session.frontendConn.close();
            session.frontendConn = undefined;
        }
        session.streamSid = undefined;
        session.lastAssistantItem = undefined;
        session.responseStartTimestamp = undefined;
        session.latestMediaTimestamp = undefined;
        session.saved_config = undefined;
        session.webhookUrl = undefined;
        session.conversationData = undefined;
        session.isConversationComplete = undefined;
        session.conversationStep = undefined;
        session.conversationHistory = undefined;
        logger.info("Session cleanup completed");
    });
}
function cleanupConnection(ws) {
    if (isOpen(ws))
        ws.close();
}
function parseMessage(data) {
    try {
        return JSON.parse(data.toString());
    }
    catch (_a) {
        return null;
    }
}
function jsonSend(ws, obj) {
    if (!isOpen(ws)) {
        return;
    }
    const message = JSON.stringify(obj);
    ws.send(message);
}
function isOpen(ws) {
    return !!ws && ws.readyState === ws_1.WebSocket.OPEN;
}
