import dotenv from 'dotenv';
dotenv.config();

/**
 * Global Configuration (Professional Final)
 * 모든 통신 주소를 동적으로 처리합니다.
 */
export const config = {
    port: process.env.PORT || 8080,
    
    // 프론트엔드 Vercel 주소
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        
        // [중요] Railway 서버 주소 - 인증 콜백 경로
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        
        // 봇 구동용 인증 정보
        nidAuth: process.env.NID_AUTH || '',
        nidSes: process.env.NID_SES || ''
    }
};