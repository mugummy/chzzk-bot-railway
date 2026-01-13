import dotenv from 'dotenv';
import path from 'path';

// Railway 환경에서는 process.env가 우선이며, .env 파일은 로컬 개발용입니다.
dotenv.config(); 

/**
 * Global Configuration (Professional Final)
 * gummybot의 모든 통신 주소와 보안 토큰을 관리합니다.
 */
export const config = {
    port: process.env.PORT || 8080,
    
    // 프론트엔드 Vercel 주소
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        
        // [중요] Railway 서버 실제 주소
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        
        // 봇 로그인 쿠키 (순수 값만 추출하는 로직은 BotInstance에서 처리)
        nidAuth: process.env.NID_AUTH || '',
        nidSes: process.env.NID_SES || process.env.NID_SESSION || ''
    }
};
