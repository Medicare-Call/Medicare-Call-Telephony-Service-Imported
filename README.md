# Medicare Call Telephony Server
<img width="3840" height="2160" alt="image" src="https://github.com/user-attachments/assets/92d363ae-f60e-4de4-a7e6-a1b606dd0537" />

- [비즈니스 서버](https://github.com/Medicare-Call/Medicare-Call-Backend)

## 주요 기능
- 실시간 음성 스트리밍 및 AI 연동: Twilio와 WebSocket을 사용하여 실시간으로 음성 데이터를 스트리밍하고 OpenAI의 음성 AI 모델과 통신하여 자연스러운 대화를 구현합니다.
- 통화 상태 관리: Twilio로부터 completed, busy, no-answer 등 통화 상태에 대한 콜백을 받아 실시간으로 통화 상태를 업데이트하고 관리합니다.
- 웹훅 기반 결과 전송: 통화가 종료되면 분석된 건강 데이터와 전체 대화 내용을 스프링 서버로 전송하여 비즈니스 로직을 철리합니다.

## Dependencies
### Backend
- Framework: Node.js, Express
- Language: TypeScript
- Real-time Communication: ws (WebSocket)
- Telephony: Twilio SDK
- AI: OpenAI API

## 시작하기
1. 저장소 복제:
```bash
git clone https://github.com/your-username/medicare-call-telephony-server.git
cd medicare-call-telephony-server/websocket-server
```
2. 종속성 설치:
```bash
npm install
```
3. `.env` 파일에 다음 환경 변수를 설정해야 합니다.

| 변수명 | 설명 | 예시 |
| --- | --- | --- |
| `PORT` | 서버가 실행될 포트 번호 | `8081` |
| `PUBLIC_URL` | 외부에서 서버에 접근할 수 있는 URL | `https://your-ngrok-url.ngrok.io` |
| `OPENAI_API_KEY` | OpenAI API 키 | `your_openai_api_key_here` |
| `WEBHOOK_URL` | 통화 결과가 전송될 웹훅 URL | `https://your-webhook-endpoint.com/api/call-result` |
| `TWILIO_ACCOUNT_SID` | Twilio 계정 SID | `your_twilio_account_sid` |
| `TWILIO_AUTH_TOKEN` | Twilio 인증 토큰 | `your_twilio_auth_token` |
| `TWILIO_CALLER_NUMBERS` | 동시 통화를 위해 쉼표로 구분된 발신자 전화번호 목록입니다. 서버는 이 목록에서 사용 가능한 번호를 자동으로 선택하여 전화를 겁니다. | `+16512341234,+16512345678` |
4. 실행 및 테스트:
- 개발 모드 실행:
```bash
npm run dev
```
이 명령어는 소스 코드 변경 시 자동으로 서버를 재시작합니다.
- 빌드:
```bash
npm run build
```
TypeScript 코드를 JavaScript로 컴파일하여 `dist`디렉토리에 저장합니다.
- 프로덕션 모드 실행:
```bash
npm start
```
컴파일된 `dist/server.js` 파일을 실행합니다.




