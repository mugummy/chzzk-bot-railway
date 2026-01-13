import dotenv from 'dotenv';
import path from 'path';

// 현재 폴더 기준 .env 로드 (로컬 개발용)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

/**
 * Global Configuration: 환경 변수 로딩 최적화
 */
export const config = {
    port: process.env.PORT || 8080,
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        
        // NID_SES와 NID_SESSION 둘 다 지원 (호환성)
        nidAuth: process.env.NID_AUTH || '',
        nidSes: process.env.NID_SES || process.env.NID_SESSION || ''
    }
};