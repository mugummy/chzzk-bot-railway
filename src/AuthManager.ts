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

export class AuthManager {
    private readonly TOKEN_URL = 'https://openapi.chzzk.naver.com/auth/v1/token';
    private readonly USER_URL = 'https://openapi.chzzk.naver.com/open/v1/users/me';
    private readonly AUTH_URL = 'https://chzzk.naver.com/account-interlock';

    constructor(
        private clientId: string,
        private clientSecret: string,
        private redirectUri: string
    ) {}

    public generateAuthUrl() {
        const state = uuidv4().replace(/-/g, '').substring(0, 16);
        const params = new URLSearchParams({
            clientId: this.clientId,
            redirectUri: this.redirectUri,
            state: state
        });
        return { url: `${this.AUTH_URL}?${params.toString()}`, state };
    }

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

            // DB 업데이트 시도 (실패해도 로그인 자체는 성공 처리)
            try {
                const { data: existing } = await supabase.from('channels').select('channel_id').eq('channel_id', user.channelId).single();
                
                if (existing) {
                    await supabase.from('channels').update({
                        session_id: session.sessionId,
                        session_data: session,
                        updated_at: new Date().toISOString()
                    }).eq('channel_id', user.channelId);
                } else {
                    await supabase.from('channels').insert({
                        channel_id: user.channelId,
                        session_id: session.sessionId,
                        session_data: session,
                        settings: { chatEnabled: true },
                        greet_settings: { enabled: true, type: 1, message: "반갑습니다!" }
                    });
                }
            } catch (dbError) {
                console.error('[AuthManager] DB Sync Warning:', dbError);
                // DB 에러가 나도 세션은 유효하므로 진행
            }

            return { success: true, session };
        } catch (e: any) {
            console.error('[AuthManager] Auth Failed:', e.response?.data || e.message);
            return { success: false, error: e.message };
        }
    }

    public async validateSession(sessionId: string): Promise<AuthSession | null> {
        const { data } = await supabase.from('channels').select('session_data').eq('session_id', sessionId).single();
        if (!data || !data.session_data) return null;
        return data.session_data as AuthSession;
    }

    private async getUserInfo(accessToken: string): Promise<ChzzkUser | null> {
        try {
            const res = await axios.get(this.USER_URL, { headers: { 'Authorization': `Bearer ${accessToken}` } });
            const content = res.data.content;
            return {
                channelId: content.channelId,
                channelName: content.channelName,
                channelImageUrl: content.channelImageUrl
            };
        } catch { return null; }
    }
}