import dotenv from 'dotenv';
import path from 'path';

// Railway 환경 변수 로드
dotenv.config(); 

/**
 * Global Configuration (Custom Typo Support)
 * 사용자의 미세한 설정 실수까지도 자동으로 감지하여 보정합니다.
 */
export const config = {
    port: process.env.PORT || 8080,
    clientOrigin: process.env.CLIENT_ORIGIN || 'https://mugumchzzkbot.vercel.app',
    
    chzzk: {
        clientId: process.env.CHZZK_CLIENT_ID || '',
        clientSecret: process.env.CHZZK_CLIENT_SECRET || '',
        redirectUri: process.env.REDIRECT_URI || 'https://web-production-19eef.up.railway.app/auth/callback',
        
        // [수정] NID_AUT (H 누락) 및 다양한 변수명 모두 지원
        nidAuth: process.env.NID_AUTH || process.env.NID_AUT || process.env.NIDAUTH || '',
        nidSes: process.env.NID_SES || process.env.NID_SESSION || process.env.NIDSESSION || ''
    }
};

// 현재 로드된 토큰 상태 출력 (보안상 앞 4자리만 출력)
const mask = (s: string) => s ? `${s.substring(0, 4)}***` : 'MISSING';
console.log(`[Config] Syncing Env: NID_AUTH(${mask(config.chzzk.nidAuth)}), NID_SES(${mask(config.chzzk.nidSes)})`);
