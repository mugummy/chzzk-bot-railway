import dotenv from 'dotenv';
import path from 'path';

// 현재 폴더 기준 .env 로드 보장
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Global Configuration: 모든 통신 주소와 환경 변수를 관리합니다.
 */
export const config = {
    port: process.env.PORT || 8080,
    
    // 프론트엔드 Vercel 주소 (기본값 설정)
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        // Railway 서버 콜백 주소
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        nidAuth: process.env.NID_AUTH || '',
        nidSes: process.env.NID_SES || ''
    }
};
