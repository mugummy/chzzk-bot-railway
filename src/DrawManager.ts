import { ChatEvent } from 'chzzk';
import { supabase } from './supabase';

interface DrawParticipant {
    id: string;
    userIdHash: string;
    nickname: string;
    role: string;
}

interface DrawSession {
    id: string;
    keyword: string;
    subsOnly: boolean;
    status: 'pending' | 'recruiting' | 'picking' | 'ended';
    participants: DrawParticipant[];
    winner: DrawParticipant | null;
    createdAt: string;
    endedAt?: string;
}

export class DrawManager {
    private bot: any;
    private channelId: string;
    private currentSession: DrawSession | null = null;
    private participantSet: Set<string> = new Set();
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(bot: any) {
        this.bot = bot;
        this.channelId = bot.getChannelId();
    }

    setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('drawStateUpdate', this.getState());
    }

    getState() {
        if (!this.currentSession) {
            return {
                isRecruiting: false,
                status: 'idle',
                participantCount: 0,
                participants: [],
                keyword: '!참여',
                subsOnly: false,
                winner: null
            };
        }

        return {
            isRecruiting: this.currentSession.status === 'recruiting',
            status: this.currentSession.status,
            participantCount: this.currentSession.participants.length,
            participants: this.currentSession.participants,
            keyword: this.currentSession.keyword,
            subsOnly: this.currentSession.subsOnly,
            winner: this.currentSession.winner
        };
    }

    async startRecruiting(keyword: string = '!참여', subsOnly: boolean = false) {
        try {
            // End any existing session
            if (this.currentSession && this.currentSession.status === 'recruiting') {
                await this.stopRecruiting();
            }

            const { data: session, error } = await supabase
                .from('draw_sessions')
                .insert({
                    channel_id: this.channelId,
                    keyword,
                    subs_only: subsOnly,
                    status: 'recruiting'
                })
                .select()
                .single();

            if (error || !session) throw error;

            this.currentSession = {
                id: session.id,
                keyword,
                subsOnly,
                status: 'recruiting',
                participants: [],
                winner: null,
                createdAt: session.created_at
            };

            this.participantSet.clear();
            this.notify();

            // Announce in chat
            if (this.bot.chat) {
                const subsText = subsOnly ? ' (구독자 전용)' : '';
                await this.bot.chat.sendChat(`[추첨 시작] 채팅에 "${keyword}" 입력으로 참여하세요!${subsText}`);
            }

            return this.currentSession;
        } catch (e) {
            console.error('[DrawManager] Failed to start recruiting:', e);
            throw e;
        }
    }

    async stopRecruiting() {
        if (!this.currentSession || this.currentSession.status !== 'recruiting') return;

        this.currentSession.status = 'pending';
        this.notify();

        // Announce in chat
        if (this.bot.chat) {
            await this.bot.chat.sendChat(`[모집 종료] 총 ${this.currentSession.participants.length}명 참여!`);
        }
    }

    handleChat(chat: ChatEvent) {
        if (!this.currentSession || this.currentSession.status !== 'recruiting') return;

        const msg = chat.message.trim();
        if (msg !== this.currentSession.keyword) return;

        const userIdHash = chat.profile.userIdHash;
        const nickname = chat.profile.nickname;

        // Already participated
        if (this.participantSet.has(userIdHash)) return;

        // Determine role (simplified - in real app, check actual subscription status)
        let role = '팬';
        const badges = chat.profile.badge || {};
        if ((badges as any).streamer) role = '계정주';
        else if ((badges as any).manager) role = '매니저';
        else if ((badges as any).subscriber) role = '구독자';

        // Subs only check
        if (this.currentSession.subsOnly && role === '팬') return;

        this.addParticipant(userIdHash, nickname, role);
    }

    private async addParticipant(userIdHash: string, nickname: string, role: string) {
        if (!this.currentSession) return;

        try {
            const { data, error } = await supabase
                .from('draw_participants')
                .insert({
                    session_id: this.currentSession.id,
                    user_id_hash: userIdHash,
                    nickname,
                    role
                })
                .select()
                .single();

            if (error) {
                // Likely duplicate, ignore
                return;
            }

            const participant: DrawParticipant = {
                id: data.id,
                userIdHash,
                nickname,
                role
            };

            this.currentSession.participants.push(participant);
            this.participantSet.add(userIdHash);
            this.notify();
        } catch (e) {
            console.error('[DrawManager] Failed to add participant:', e);
        }
    }

    async pickWinner(): Promise<DrawParticipant | null> {
        if (!this.currentSession || this.currentSession.participants.length === 0) return null;

        // Stop recruiting if still active
        if (this.currentSession.status === 'recruiting') {
            await this.stopRecruiting();
        }

        this.currentSession.status = 'picking';
        this.notify();

        const participants = this.currentSession.participants;
        const randomIndex = Math.floor(Math.random() * participants.length);
        const winner = participants[randomIndex];

        try {
            await supabase
                .from('draw_sessions')
                .update({
                    status: 'ended',
                    winner_id_hash: winner.userIdHash,
                    winner_nickname: winner.nickname,
                    ended_at: new Date().toISOString()
                })
                .eq('id', this.currentSession.id);

            this.currentSession.winner = winner;
            this.currentSession.status = 'ended';
            this.notify();

            // Announce winner
            if (this.bot.chat) {
                await this.bot.chat.sendChat(`[당첨] ${winner.nickname}님 축하합니다!`);
            }

            return winner;
        } catch (e) {
            console.error('[DrawManager] Failed to pick winner:', e);
            return null;
        }
    }

    async resetDraw() {
        this.currentSession = null;
        this.participantSet.clear();
        this.notify();
    }

    async getDrawHistory(): Promise<any[]> {
        try {
            const { data } = await supabase
                .from('draw_sessions')
                .select('*')
                .eq('channel_id', this.channelId)
                .eq('status', 'ended')
                .order('created_at', { ascending: false })
                .limit(10);

            return data || [];
        } catch (e) {
            return [];
        }
    }
}
