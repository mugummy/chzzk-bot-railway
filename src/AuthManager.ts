import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from './supabase';

export interface ChzzkTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface ChzzkUser {
    channelId: string;
    channelName: string;
    channelImageUrl?: string;
}

export interface AuthSession {
    sessionId: string;
    user: ChzzkUser;
    tokens: ChzzkTokens;
    createdAt: number;
}

/**
 * AuthManager: 치지직 OAuth2 인증 및 세션을 관리합니다.
 */
export class AuthManager {
    private readonly AUTH_URL = 'https://chzzk.naver.com/account-interlock';
    private readonly TOKEN_URL = 'https://openapi.chzzk.naver.com/auth/v1/token';
    private readonly USER_URL = 'https://openapi.chzzk.naver.com/open/v1/users/me';

    constructor(
        private clientId: string,
        private clientSecret: string,
        private redirectUri: string
    ) {}

    /**
     * 네이버 로그인 URL 생성 (State 보안 포함)
     */
    public generateAuthUrl(redirectPath?: string) {
        const state = uuidv4().replace(/-/g, '').substring(0, 16);
        const params = new URLSearchParams({
            clientId: this.clientId,
            redirectUri: this.redirectUri,
            state: state
        });
        return { url: `${this.AUTH_URL}?${params.toString()}`, state };
    }

    /**
     * 인증 코드를 토큰으로 교환하고 세션 생성
     */
    public async exchangeCodeForTokens(code: string, state: string): Promise<{ success: boolean; session?: AuthSession; error?: string }> {
        try {
            const res = await axios.post(this.TOKEN_URL, {
                grantType: 'authorization_code',
                clientId: this.clientId,
                clientSecret: this.clientSecret,
                code,
                state
            });

            const tokenData = res.data.content;
            const user = await this.getUserInfo(tokenData.accessToken);
            if (!user) throw new Error('사용자 정보를 가져올 수 없습니다.');

            const session: AuthSession = {
                sessionId: uuidv4(),
                user,
                tokens: {
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    expiresAt: Date.now() + (tokenData.expiresIn * 1000)
                },
                createdAt: Date.now()
            };

            // DB에 세션 저장 (다른 데이터는 유지하고 session_id와 session_data만 업데이트)
            await supabase.from('channels').upsert({
                channel_id: user.channelId,
                session_id: session.sessionId,
                session_data: session,
                updated_at: new Date().toISOString()
            });

            return { success: true, session };
        } catch (e: any) {
            console.error('[AuthManager] Exchange Error:', e.response?.data || e.message);
            return { success: false, error: e.message };
        }
    }

    /**
     * 세션 토큰 유효성 검증
     */
    public async validateSession(sessionId: string): Promise<AuthSession | null> {
        const { data, error } = await supabase
            .from('channels')
            .select('session_data')
            .eq('session_id', sessionId)
            .single();

        if (error || !data || !data.session_data) return null;
        
        const session = data.session_data as AuthSession;
        
        // 토큰 만료 체크 및 갱신 로직 추가 가능
        return session;
    }

    private async getUserInfo(accessToken: string): Promise<ChzzkUser | null> {
        try {
            const res = await axios.get(this.USER_URL, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const content = res.data.content;
            return {
                channelId: content.channelId,
                channelName: content.channelName,
                channelImageUrl: content.channelImageUrl
            };
        } catch { return null; }
    }
}