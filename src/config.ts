import dotenv from 'dotenv';
dotenv.config();

/**
 * Global Configuration: 서버와 클라이언트의 통신 주소를 정의합니다.
 */
export const config = {
    port: process.env.PORT || 8080,
    // 프론트엔드(Vercel) 주소를 명확히 지정
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        // Railway 서버의 실제 주소 (인증 콜백용)
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        nidAuth: process.env.NID_AUTH || '',
        nidSes: process.env.NID_SES || ''
    }
};
