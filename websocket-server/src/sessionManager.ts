import { RawData, WebSocket } from "ws";
import winston from "winston";
import redisClient, {SESSION_TTL} from "./redisClient";
import {callConnections, frontendConnections, modelConnections} from "./server";

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

interface Session {
  twilioConn?: WebSocket;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  streamSid?: string;
  saved_config?: any;
  lastAssistantItem?: string;
  responseStartTimestamp?: number;
  latestMediaTimestamp?: number;
  openAIApiKey?: string;
  webhookUrl?: string;
  conversationData?: any;
  isConversationComplete?: boolean;
  conversationStep?: number;
  conversationHistory?: { is_elderly: boolean; conversation: string }[];
}
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


// --- Redis와 상호작용하는 헬퍼 함수 ---
async function getSession(sessionId: string): Promise<Session> {
  const sessionData = await redisClient.get(`session:${sessionId}`);
  return sessionData ? JSON.parse(sessionData) : {};
}
async function saveSession(sessionId: string, sessionData: Session) {
  await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionData), {
    EX: SESSION_TTL,
  });
}
async function deleteSession(sessionId: string) {
  await redisClient.del(`session:${sessionId}`);
}


// 최종 응답 JSON을 웹훅 URL로 전송하는 함수
export async function sendToWebhook(data: any, webhookUrl: string, sessionId: string) {
  if (!webhookUrl) {
    logger.info(`(Session: ${sessionId}) - Webhook URL이 설정되지 않아 전송을 건너뜁니다.`);
    return;
  }
  const formattedData = {
    content: data,
    sessionId: sessionId // 데이터에 세션 ID 포함
  };

  logger.info(`(Session: ${sessionId}) 🌐 Sending to webhook:`, webhookUrl);
  logger.info(`(Session: ${sessionId}) 📦 Webhook data:`, JSON.stringify(formattedData, null, 2));

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formattedData),
    });

    if (response.ok) {
      logger.info(`(Session: ${sessionId}) ✅ Successfully sent data to webhook:`, webhookUrl);
    } else {
      logger.error(`(Session: ${sessionId}) ❌ Failed to send data to webhook:`, response.status, response.statusText);
    }
  } catch (error) {
    logger.error(`(Session: ${sessionId}) ❌ Error sending data to webhook:`, error);
  }
}

// 테스트용 웹훅 전송 함수
export async function sendTestWebhook(sessionId: string, webhookUrl?: string, testData?: any) {
  let targetUrl = webhookUrl;

  if (!targetUrl) {
    targetUrl = process.env.WEBHOOK_URL;
  }

  if (!targetUrl) {
    logger.info(`(Session: ${sessionId}) ❌ 테스트 웹훅 전송 불가: Webhook URL이 설정되지 않았습니다.`);
    return { success: false, error: "No webhook URL configured" };
  }

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

  const formattedData = {
    content: dataToSend,
    test: true,
    timestamp: new Date().toISOString(),
    sessionId: sessionId,
  };

  logger.info(`(Session: ${sessionId}) 🧪 Sending TEST webhook to:`, targetUrl);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formattedData),
    });

    if (response.ok) {
      return { success: true, message: "Test webhook sent successfully" };
    } else {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

// AI 응답에서 최종 JSON을 감지하고 추출하는 함수: 현재 쓰이지 않는 것 같지만 일단 삭제하지 않음
function extractFinalJson(text: string): any | null {
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
          } else {
            logger.info("❌ JSON found but missing required fields");
          }
        } catch (parseError) {
          logger.info(`❌ Pattern ${i + 1} matched but JSON parsing failed:`, parseError);
        }
      }
    }
    
    logger.info("❌ No valid JSON pattern found");
    return null;
  } catch (error) {
    logger.error('❌ Error in extractFinalJson:', error);
    return null;
  }
}

export async function handleCallConnection(ws: WebSocket, sessionId: string, openAIApiKey: string, webhookUrl?: string) {
  // 새로운 세션을 생성하고 Redis에 저장
  const newSession: Session = {
    openAIApiKey,
    webhookUrl,
    conversationHistory: [],
  };
  await saveSession(sessionId, newSession);
  logger.info(`Call connection established for session: ${sessionId}`);

  ws.on("message", (data) => handleTwilioMessage(data, sessionId));
  ws.on("error", (err) => {
    logger.error(`Twilio WS Error for session ${sessionId}:`, err);
    ws.close();
  });
  ws.on("close", () => {
    logger.info(`Twilio WS connection closed for session: ${sessionId}`);
    callConnections.delete(sessionId);
    closeAllConnections(sessionId);
  });
}

//모니터링용
export function handleFrontendConnection(ws: WebSocket, sessionId: string) {
  logger.info(`Frontend connection established for session: ${sessionId}`);
  ws.on("message", (data) => handleFrontendMessage(data, sessionId));
  ws.on("close", () => {
    logger.info(`Frontend WS connection closed for session: ${sessionId}`);
    frontendConnections.delete(sessionId);
  });
}

async function handleTwilioMessage(data: RawData, sessionId: string) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch { return; }

  if (msg.event !== "media") {
    logger.info(`Twilio message for session ${sessionId}:`, msg.event);
  }

  const session = await getSession(sessionId);
  const modelConn = modelConnections.get(sessionId);

  switch (msg.event) {
    case "start":
      session.streamSid = msg.start.streamSid;
      await saveSession(sessionId, session);
      await tryConnectModel(sessionId);
      break;
    case "media":
      session.latestMediaTimestamp = msg.media.timestamp;
      // 세션 저장 부하를 줄이기 위해 timestamp는 매번 저장하지 않을 수 있음 (선택사항)
      if (isOpen(modelConn)) {
        jsonSend(modelConn, {
          type: "input_audio_buffer.append",
          audio: msg.media.payload, //Twilio에서 받은 음성을 OpenAI로 전송
        });
      }
      break;
    case "stop":
    case "close":
      await closeAllConnections(sessionId);
      break;
  }
}

async function handleFrontendMessage(data: RawData, sessionId: string) {
  let msg;
  try {
    msg = parseMessage(data);
  } catch (err) {
    logger.error(`[handleFrontendMessage] parseMessage 에러 (Session: ${sessionId}):`, err);
    return;
  }
  if (!msg) return;

  // 웹훅 테스트 요청 처리
  if (msg.type === "webhook.test") {
    logger.info(`Webhook test 요청 (Session: ${sessionId})`);
    sendTestWebhook(sessionId, msg.webhookUrl, msg.testData)
        .then(result => {
          const frontendConn = frontendConnections.get(sessionId);
          if (frontendConn) {
            jsonSend(frontendConn, { type: "webhook.test.result", ...result });
          }
        })
        .catch(error => {
          logger.error("[handleFrontendMessage] webhook test 에러:", error);
        });
    return;
  }

  try {
    const modelConn = modelConnections.get(sessionId);
    if (isOpen(modelConn)) {
      jsonSend(modelConn, msg);
    }
    // 세션 설정을 업데이트하는 경우
    if (msg.type === "session.update") {
      const session = await getSession(sessionId);
      session.saved_config = msg.session;
      await saveSession(sessionId, session);
    }
  } catch (err) {
    logger.error(`[handleFrontendMessage] modelConn 전송/세션 저장 에러 (Session: ${sessionId}):`, err);
  }
}

async function tryConnectModel(sessionId: string) {
  const session = await getSession(sessionId);
  if (!callConnections.has(sessionId) || !session.streamSid || !session.openAIApiKey) return;

  const modelConn = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${session.openAIApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
  );
  modelConnections.set(sessionId, modelConn);
  // 이 부분은 논의가 필요: modelConn을 어떻게 관리할 것인가?
  // 여기서는 간단히 session 객체에 저장하지 않고, Redis 상태와 메모리 연결을 조합해서 사용

  modelConn.on("open", async () => {
    logger.info("✅ OpenAI WebSocket connected");
    const config = session.saved_config || {};
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,           // 음성 감지 임계값
          prefix_padding_ms: 300,   // 음성 시작 전 패딩
          silence_duration_ms: 200  // 침묵 지속 시간
        },
        voice: "ash",
        input_audio_transcription: { model: "whisper-1" }, //stt
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",

        // 소음 제거 및 오디오 처리 옵션
        input_audio_preprocessing: {
          noise_suppression: true,    // 소음 제거 활성화
          echo_cancellation: true,    // 에코 제거
          auto_gain_control: true     // 자동 음량 조절
        },

        ...config,
      },
    };
    logger.info("📝 Sending session config:", JSON.stringify(sessionConfig, null, 2));
    jsonSend(session.modelConn, sessionConfig);
    logger.info("📝 Sending initial prompt...");
    sendUserMessage(modelConn, INITIAL_PROMPT);
  });

  modelConn.on("message", (data) =>{
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
      handleModelMessage(data, sessionId);
    } catch (err) {
      logger.error("[tryConnectModel] on message 핸들러 에러:", err);
    }
  })

  modelConn.on("close", () => {
    logger.info(`OpenAI WS closed for session: ${sessionId}`);
  });
  modelConn.on("error", (error) => {
    logger.error("[tryConnectModel] OpenAI WebSocket 에러:", error);
    closeModel(sessionId);
  });
}

function sendUserMessage(modelConn: WebSocket, text: string) {
  try {
    logger.info("📤 Sending user message:", text.substring(0, 100) + "...");
    if (!isOpen(modelConn)) {
      logger.error("[sendUserMessage] modelConn 미연결, 메시지 전송 불가");
      return;
    }
    /* ① user 메시지 생성 */
    const userMessage = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",  // ← 'text'가 아니라 반드시 'input_text'
            text,
          },
        ],
      },
    };
    jsonSend(modelConn, userMessage);

    /* ② assistant 응답 트리거 */
    const responseCreate = { type: "response.create" };
    jsonSend(modelConn, responseCreate);
  } catch (err) {
    logger.error("[sendUserMessage] 전체 예외:", err);
  }
}

async function handleModelMessage(data: RawData, sessionId: string) {
  let event;
  try {
    event = parseMessage(data);
  } catch (err) {
    logger.error("[handleModelMessage] parseMessage 에러:", err);
    return; }
  if (!event) return;

  // 프론트엔드 연결이 있다면, 모든 모델 이벤트를 그대로 전달
  const frontendConn = frontendConnections.get(sessionId);
  if (isOpen(frontendConn)) {
    jsonSend(frontendConn, event);
  }

  const session = await getSession(sessionId);
  if (!session) return; // 세션이 없으면 중단

  try {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        await handleTruncation(sessionId);
        break;

      case "response.audio.delta":
        const twilioConn = callConnections.get(sessionId);
        if (isOpen(twilioConn) && session.streamSid) {
          if (session.responseStartTimestamp === undefined) {
            session.responseStartTimestamp = session.latestMediaTimestamp || 0;
          }
          if (event.item_id) session.lastAssistantItem = event.item_id;

          // AI 음성 데이터를 Twilio로 전송
          jsonSend(twilioConn, {
            event: "media",
            streamSid: session.streamSid,
            media: {payload: event.delta},
          });
          jsonSend(twilioConn, {event: "mark", streamSid: session.streamSid});

          // 변경된 세션 상태 저장
          await saveSession(sessionId, session);
        }
        break;

      case "response.output_item.done":
      case "conversation.item.input_audio_transcription.completed":

        if (event.type === "response.output_item.done" && event.item?.role === 'assistant') {
          const contentItem = event.item.content?.[0];
          const conversationText = contentItem?.text || contentItem?.transcript;

          if (conversationText) {
            if (!session.conversationHistory) session.conversationHistory = [];
            session.conversationHistory.push({
              is_elderly: false, // AI이므로 false
              conversation: conversationText,
            });
            await saveSession(sessionId, session);
            logger.info(`AI 응답 기록 업데이트 (Session: ${sessionId})`);
          }

        } else if (event.type === "conversation.item.input_audio_transcription.completed") {
          const conversationText = event.transcript;

          if (conversationText) {
            if (!session.conversationHistory) session.conversationHistory = [];
            session.conversationHistory.push({
              is_elderly: true, // 사용자이므로 true
              conversation: conversationText,
            });
            await saveSession(sessionId, session);
            logger.info(`사용자 발화 기록 업데이트 (Session: ${sessionId})`);
          }
        }
    }
  } catch (err) {
    logger.error(`[handleModelMessage] switch-case 처리 중 에러 (Session: ${sessionId}):`, err);
  }
}


async function handleTruncation(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session.lastAssistantItem || session.responseStartTimestamp === undefined) {
    return;
  }

  const elapsedMs = (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
  const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;

  // AI에게 응답 잘라내기(truncate) 명령 전송
  const modelConn = modelConnections.get(sessionId);
  if (isOpen(modelConn)) {
    jsonSend(modelConn, {
      type: "conversation.item.truncate",
      item_id: session.lastAssistantItem,
      content_index: 0,
      audio_end_ms,
    });
  }

  // Twilio의 오디오 출력 버퍼 비우기
  const twilioConn = callConnections.get(sessionId);
  if (isOpen(twilioConn) && session.streamSid) {
    jsonSend(twilioConn, { event: "clear", streamSid: session.streamSid });
  }

  // 사용한 세션 변수 초기화 후 Redis에 저장
  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
  await saveSession(sessionId, session);
}


function closeModel(sessionId: string) {

  const modelConn = modelConnections.get(sessionId);
  if (isOpen(modelConn)) {
    modelConn.close();
  }
  modelConnections.delete(sessionId);

  logger.info(`OpenAI 모델 연결 정리 완료 (Session: ${sessionId})`);
}


async function closeAllConnections(sessionId: string) {
  logger.info(`모든 연결 정리 시작 (Session: ${sessionId})...`);

  const session = await getSession(sessionId);

  try {
    if (session?.conversationHistory && session.conversationHistory.length > 0 && session.webhookUrl) {
      logger.info(`📤 대화 기록 웹훅 전송 (Session: ${sessionId})`);
      await sendToWebhook(session.conversationHistory, session.webhookUrl, sessionId); // webhookUrl 전달
    }
  } catch (error) {
    logger.error(`❌ 웹훅 전송 실패 (Session: ${sessionId}):`, error);
  }

  const twilioConn = callConnections.get(sessionId);
  if (isOpen(twilioConn)) twilioConn.close();

  const modelConn = modelConnections.get(sessionId);
  if (isOpen(modelConn)) modelConn.close();

  const frontendConn = frontendConnections.get(sessionId);
  if (isOpen(frontendConn)) frontendConn.close();

  callConnections.delete(sessionId);
  modelConnections.delete(sessionId);
  frontendConnections.delete(sessionId);

  await deleteSession(sessionId);

  logger.info(`✅ 세션 정리 완료 (Session: ${sessionId})`);
}


function cleanupConnection(ws?: WebSocket) {
  if (isOpen(ws)) ws.close();
}

function parseMessage(data: RawData): any {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (!isOpen(ws)) {
    return;
  }
  
  const message = JSON.stringify(obj);
  ws.send(message);
}

function isOpen(ws?: WebSocket): ws is WebSocket {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

