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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCallConnection = handleCallConnection;
exports.sendToWebhook = sendToWebhook;
exports.getSessionStatus = getSessionStatus;
exports.getAllActiveSessions = getAllActiveSessions;
const ws_1 = require("ws");
let sessions = new Map();
function getSession(sessionId) {
    return sessions.get(sessionId);
}
function createSession(callSid, config) {
    const session = {
        sessionId: callSid, // sessionId = callSid
        callSid: callSid, // CallSid 명시적 저장
        elderId: config.elderId,
        prompt: config.prompt,
        openAIApiKey: config.openAIApiKey,
        webhookUrl: config.webhookUrl,
        conversationHistory: []
    };
    sessions.set(callSid, session);
    console.log(`📞 새 세션 생성: ${callSid} (CallSid 사용, elderId: ${config.elderId || 'N/A'})`);
    return session;
}
// === 📞 전화 연결 처리 함수 ===
function handleCallConnection(ws, openAIApiKey, webhookUrl, elderId, prompt, callSid) {
    const sessionId = callSid || `fallback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    if (!callSid) {
        console.warn(`⚠️ CallSid가 제공되지 않음. 폴백 ID 사용: ${sessionId}`);
    }
    if (!elderId) {
        console.error(`❌ elderId가 필수입니다. sessionId: ${sessionId}`);
        ws.close();
        return sessionId;
    }
    // 세션 생성 시 elderId와 prompt 포함
    const session = createSession(sessionId, {
        openAIApiKey,
        elderId,
        prompt,
        webhookUrl
    });
    session.twilioConn = ws;
    ws.on("message", (data) => handleTwilioMessage(sessionId, data));
    ws.on("error", () => ws.close());
    ws.on("close", () => closeAllConnections(sessionId));
    console.log(`✅ 세션 생성 완료 - CallSid: ${sessionId}, elderId: ${elderId}, prompt: ${prompt ? '설정됨' : '없음'}`);
    return sessionId;
}
// === 실시간 대화 처리 (필수) ===
function handleTwilioMessage(sessionId, data) {
    const session = getSession(sessionId);
    if (!session)
        return;
    const msg = parseMessage(data);
    if (!msg)
        return;
    // media 이벤트가 아닌 경우만 로그 출력
    if (msg.event !== "media") {
        console.log("📞 Twilio 메시지:", msg.event, `(CallSid: ${session.callSid})`);
    }
    switch (msg.event) {
        case "start":
            console.log(`📞 통화 시작 (CallSid: ${session.callSid}), streamSid: ${msg.start.streamSid}`);
            session.streamSid = msg.start.streamSid;
            session.latestMediaTimestamp = 0;
            session.lastAssistantItem = undefined;
            session.responseStartTimestamp = undefined;
            // OpenAI 연결 시도
            connectToOpenAI(sessionId);
            break;
        case "media":
            // 실시간 음성 데이터를 OpenAI로 전달
            session.latestMediaTimestamp = msg.media.timestamp;
            if (isOpen(session.modelConn)) {
                jsonSend(session.modelConn, {
                    type: "input_audio_buffer.append",
                    audio: msg.media.payload,
                });
            }
            break;
        case "stop":
        case "close":
            console.log(`📞 통화 종료 신호 수신 (CallSid: ${session.callSid})`);
            closeAllConnections(sessionId);
            break;
    }
}
// === OpenAI 연결 함수 ===
function connectToOpenAI(sessionId) {
    const session = getSession(sessionId);
    if (!session || !session.twilioConn || !session.streamSid || !session.openAIApiKey) {
        return;
    }
    if (isOpen(session.modelConn))
        return; // 이미 연결됨
    console.log(`🔗 OpenAI 연결 중... (CallSid: ${session.callSid})`);
    session.modelConn = new ws_1.WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17", {
        headers: {
            Authorization: `Bearer ${session.openAIApiKey}`,
            "OpenAI-Beta": "realtime=v1",
        },
    });
    // OpenAI 연결 성공
    session.modelConn.on("open", () => {
        console.log(`✅ OpenAI 연결 완료 (CallSid: ${session.callSid})`);
        // 세션 설정
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                turn_detection: {
                    type: "server_vad",
                    threshold: 0.6,
                    prefix_padding_ms: 660,
                    silence_duration_ms: 850
                },
                voice: "ash",
                input_audio_transcription: { model: "whisper-1" },
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_noise_reduction: { type: "near_field" },
            },
        };
        jsonSend(session.modelConn, sessionConfig);
        // 초기 프롬프트 전송
        if (session.prompt) {
            sendUserMessage(sessionId, session.prompt);
        }
    });
    // OpenAI 메시지 처리
    session.modelConn.on("message", (data) => handleOpenAIMessage(sessionId, data));
    // 연결 오류 처리
    session.modelConn.on("error", (error) => {
        console.error(`❌ OpenAI 연결 오류 (CallSid: ${session.callSid}):`, error);
    });
    session.modelConn.on("close", () => {
        console.log(`🔌 OpenAI 연결 종료 (CallSid: ${session.callSid})`);
    });
}
// === 사용자 메시지 전송 ===
function sendUserMessage(sessionId, text) {
    const session = getSession(sessionId);
    if (!session || !isOpen(session.modelConn))
        return;
    const userMessage = {
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
        },
    };
    jsonSend(session.modelConn, userMessage);
    jsonSend(session.modelConn, { type: "response.create" });
}
// === OpenAI 메시지 처리 ===
function handleOpenAIMessage(sessionId, data) {
    const session = getSession(sessionId);
    if (!session)
        return;
    const event = parseMessage(data);
    if (!event)
        return;
    switch (event.type) {
        case "input_audio_buffer.speech_started":
            // 사용자 말하기 시작 - AI 응답 중단
            handleTruncation(sessionId);
            break;
        case "response.audio.delta":
            // AI 음성 응답을 Twilio로 전달
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
        case "response.output_item.done":
            // AI 응답 완료 - 텍스트 저장
            const { item } = event;
            if (item.type === "message" && item.role === "assistant") {
                const content = item.content;
                if (content && Array.isArray(content)) {
                    for (const contentItem of content) {
                        let aiResponse = null;
                        if (contentItem.type === "text" && contentItem.text) {
                            aiResponse = contentItem.text;
                        }
                        else if (contentItem.type === "audio" && contentItem.transcript) {
                            aiResponse = contentItem.transcript;
                        }
                        if (aiResponse) {
                            console.log(`🤖 AI (CallSid: ${session.callSid}):`, aiResponse);
                            session.conversationHistory.push({
                                is_elderly: false,
                                conversation: aiResponse
                            });
                            console.log(`📊 대화 기록 (CallSid: ${session.callSid}): ${session.conversationHistory.length}개`);
                        }
                    }
                }
            }
            break;
        case "conversation.item.input_audio_transcription.completed":
            // 사용자 음성 인식 완료 - 텍스트 저장
            if (event.transcript) {
                console.log(`👤 사용자 (CallSid: ${session.callSid}):`, event.transcript);
                session.conversationHistory.push({
                    is_elderly: true,
                    conversation: event.transcript
                });
                console.log(`💾 사용자 응답 저장 (CallSid: ${session.callSid}) - 총 ${session.conversationHistory.length}개`);
            }
            break;
    }
}
// === 응답 중단 처리 ===
function handleTruncation(sessionId) {
    const session = getSession(sessionId);
    if (!session || !session.lastAssistantItem || session.responseStartTimestamp === undefined) {
        return;
    }
    const elapsedMs = (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
    const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;
    // OpenAI에 중단 명령
    if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, {
            type: "conversation.item.truncate",
            item_id: session.lastAssistantItem,
            content_index: 0,
            audio_end_ms,
        });
    }
    // Twilio 스트림 클리어
    if (session.twilioConn && session.streamSid) {
        jsonSend(session.twilioConn, {
            event: "clear",
            streamSid: session.streamSid,
        });
    }
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
}
// === 웹훅 전송 함수 ===
function sendToWebhook(sessionId, conversationHistory) {
    return __awaiter(this, void 0, void 0, function* () {
        const session = getSession(sessionId);
        const webhookUrl = (session === null || session === void 0 ? void 0 : session.webhookUrl) || process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            console.log("웹훅 URL이 설정되지 않음");
            return;
        }
        const formattedData = {
            sessionId,
            callSid: session === null || session === void 0 ? void 0 : session.callSid, // CallSid 추가
            elderId: session === null || session === void 0 ? void 0 : session.elderId,
            content: conversationHistory
        };
        console.log(`🌐 웹훅 전송 (CallSid: ${session === null || session === void 0 ? void 0 : session.callSid}):`, webhookUrl);
        try {
            const response = yield fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formattedData),
            });
            if (response.ok) {
                console.log(`✅ 웹훅 전송 성공 (CallSid: ${session === null || session === void 0 ? void 0 : session.callSid})`);
            }
            else {
                console.error(`❌ 웹훅 전송 실패 (CallSid: ${session === null || session === void 0 ? void 0 : session.callSid}):`, response.status);
            }
        }
        catch (error) {
            console.error(`❌ 웹훅 오류 (CallSid: ${session === null || session === void 0 ? void 0 : session.callSid}):`, error);
        }
    });
}
// === 🏁 통화 종료 처리 (필수) ===
function closeAllConnections(sessionId) {
    var _a;
    const session = getSession(sessionId);
    if (!session)
        return;
    console.log(`🔌 세션 종료 처리 (CallSid: ${session.callSid})...`);
    console.log(`📊 대화 기록: ${((_a = session.conversationHistory) === null || _a === void 0 ? void 0 : _a.length) || 0}개`);
    // 웹훅 전송 (비동기)
    const sendWebhookPromise = () => __awaiter(this, void 0, void 0, function* () {
        if (session.conversationHistory && session.conversationHistory.length > 0) {
            console.log(`📤 대화 기록 웹훅 전송 중 (CallSid: ${session.callSid})...`);
            try {
                yield sendToWebhook(sessionId, session.conversationHistory);
                console.log(`✅ 웹훅 전송 완료 (CallSid: ${session.callSid})`);
            }
            catch (error) {
                console.error(`❌ 웹훅 전송 실패 (CallSid: ${session.callSid}):`, error);
            }
        }
        else {
            console.log(`❌ 전송할 대화 기록 없음 (CallSid: ${session.callSid})`);
        }
    });
    // 정리 작업
    Promise.resolve(sendWebhookPromise()).finally(() => {
        // WebSocket 연결 종료
        if (session.twilioConn) {
            session.twilioConn.close();
            session.twilioConn = undefined;
        }
        if (session.modelConn) {
            session.modelConn.close();
            session.modelConn = undefined;
        }
        // 세션 삭제
        sessions.delete(sessionId);
        console.log(`🧹 세션 정리 완료 (CallSid: ${session.callSid})`);
    });
}
// === 🛠️ 유틸리티 함수들 ===
function parseMessage(data) {
    try {
        return JSON.parse(data.toString());
    }
    catch (_a) {
        return null;
    }
}
function jsonSend(ws, obj) {
    if (!isOpen(ws))
        return;
    ws.send(JSON.stringify(obj));
}
function isOpen(ws) {
    return !!ws && ws.readyState === ws_1.WebSocket.OPEN;
}
// === 📊 상태 조회 함수들 ===
function getSessionStatus(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        return { exists: false };
    }
    return {
        exists: true,
        sessionId: session.sessionId,
        callSid: session.callSid, // CallSid 추가
        elderId: session.elderId,
        conversationCount: session.conversationHistory.length,
        isActive: isOpen(session.twilioConn) && isOpen(session.modelConn)
    };
}
function getAllActiveSessions() {
    return {
        totalSessions: sessions.size,
        activeSessions: Array.from(sessions.values()).map(session => ({
            sessionId: session.sessionId,
            callSid: session.callSid, // CallSid 추가
            elderId: session.elderId,
            conversationCount: session.conversationHistory.length,
            isActive: isOpen(session.twilioConn) && isOpen(session.modelConn)
        }))
    };
}
