import { createClient } from "redis";
import winston from "winston"; // 로거는 기존 것을 활용

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

const REDIS_HOST = process.env.REDIS_HOST || '0.0.0.0';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const redisClient = createClient({
    socket: {
        host: REDIS_HOST,
        port: REDIS_PORT
    }
});

redisClient.on('error', (err) => {
    logger.error('Redis Client Error', err);
});

redisClient.on('connect', () => {
    logger.info('✅ Connected to Redis successfully');
});

redisClient.connect();

// 세션 데이터에 대한 TTL(Time To Live, 유효 시간)을 24시간으로 설정
export const SESSION_TTL = 86400;

export default redisClient;
