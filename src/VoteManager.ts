import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface VoteOption {
    id: string;
    label: string;
    count: number;
}

export interface Vote {
    id: string;
    title: string;
    status: 'ready' | 'active' | 'ended';
    mode: 'normal' | 'donation';
    options: VoteOption[];
    totalParticipants: number;
}

export class VoteManager {
    private currentVote: Vote | null = null;
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('voteStateUpdate', this.getState());
        this.bot.overlayManager?.updateOverlay('vote', this.currentVote);
    }

    public getState() {
        return { currentVote: this.currentVote };
    }

    public setCurrentVote(vote: Vote | null) {
        this.currentVote = vote;
    }

    // 투표 생성
    public async createVote(title: string, options: string[], mode: 'normal' | 'donation' = 'normal') {
        console.log(`[VoteManager] Creating vote: ${title}, Options: ${JSON.stringify(options)}`);
        
        try {
            const { data: voteData, error } = await supabase
                .from('votes')
                .insert({ channel_id: this.bot.getChannelId(), title, mode, status: 'ready' })
                .select()
                .single();

            if (error) {
                console.error('[VoteManager] Vote DB Error:', error);
                // 스키마 에러일 경우 사용자에게 알림 필요
                throw new Error(`투표 생성 DB 에러: ${error.message}`);
            }
            if (!voteData) throw new Error('투표 생성 실패: 데이터 없음');

            // 옵션 데이터 준비
            const optionInserts = options.map(label => ({
                vote_id: voteData.id,
                label: String(label), 
                count: 0
            }));

            let optionsData = [];
            try {
                const { data, error: optError } = await supabase
                    .from('vote_options')
                    .insert(optionInserts)
                    .select();
                
                if (optError) throw optError;
                optionsData = data || [];
            } catch (optErr: any) {
                console.error('[VoteManager] Option Insert Error:', optErr);
                // 테이블이 없거나 스키마 문제일 경우, 메모리 상에서라도 동작하도록 함
                if (optErr.code === 'PGRST205') {
                    console.warn('[VoteManager] !! 중요 !!: vote_options 테이블을 찾을 수 없습니다. Supabase에서 "NOTIFY pgrst, \'reload schema\';"를 실행해주세요.');
                }
            }

            // DB 리턴값 혹은 입력값 기반으로 초기화
            this.currentVote = {
                id: voteData.id,
                title: voteData.title,
                status: 'ready',
                mode: voteData.mode,
                options: (optionsData.length > 0) 
                    ? optionsData.map((o: any) => ({ id: o.id, label: o.label, count: 0 }))
                    : options.map((label, i) => ({ id: `temp_${i}`, label: String(label), count: 0 })),
                totalParticipants: 0
            };
            
            this.notify();

        } catch (err) {
            console.error('[VoteManager] Critical Error in createVote:', err);
            // 에러를 던지지 않고 로그만 남겨서 서버 크래시 방지
        }
    }

    // 투표 시작
    public async startVote() {
        if (!this.currentVote) return;
        this.currentVote.status = 'active';
        await supabase.from('votes').update({ status: 'active' }).eq('id', this.currentVote.id);
        
        // [Fix] 상세 채팅 알림
        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            const modeText = this.currentVote.mode === 'normal' ? '일반 투표(1인 1표)' : '후원 투표(금액 비례)';
            
            const optionsText = this.currentVote.options.map((o: any, i: number) => {
                const label = typeof o === 'string' ? o : (o.label || '항목');
                return `${i+1}. ${label}`;
            }).join(' / ');
            
            this.bot.chat.sendChat(`📢 [투표 시작] ${this.currentVote.title}`);
            this.bot.chat.sendChat(`📌 방식: ${modeText}`);
            this.bot.chat.sendChat(`📝 항목: ${optionsText}`);
            this.bot.chat.sendChat(`👉 채팅창에 '!투표 번호'를 입력하세요! (예: !투표 1)`);
        }
        
        this.notify();
    }

    // 투표 종료
    public async endVote() {
        if (!this.currentVote) return;
        this.currentVote.status = 'ended';
        await supabase.from('votes').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', this.currentVote.id);
        
        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            this.bot.chat.sendChat(`🛑 [투표 마감] '${this.currentVote.title}' 투표가 종료되었습니다.`);
            
            if ((this.currentVote.totalParticipants || 0) > 0 && this.currentVote.options.length > 0) {
                const topOption = this.currentVote.options.reduce((prev, current) => (prev.count > current.count) ? prev : current);
                this.bot.chat.sendChat(`🏆 최다 득표: ${topOption.label} (${topOption.count}표)`);
            } else {
                this.bot.chat.sendChat(`💨 참여자가 없어 결과가 없습니다.`);
            }
        }

        this.notify();
    }

    // [New] 투표 초기화
    public async resetVote() {
        this.currentVote = null;
        this.bot.overlayManager?.setView('none');
        this.notify();
    }

    // [New] 투표 삭제
    public async deleteVote(voteId: string) {
        await supabase.from('votes').delete().eq('id', voteId);
        if (this.currentVote?.id === voteId) {
            this.currentVote = null;
        }
        this.notify();
    }

    // [New] 투표자 명단 가져오기
    public async getBallots(voteId: string) {
        const { data: ballots } = await supabase
            .from('vote_ballots')
            .select(`user_id_hash, amount, created_at, option_id`)
            .eq('vote_id', voteId);
            
        if (!ballots) return [];

        const userIds = ballots.map(b => b.user_id_hash);
        const { data: users } = await supabase
            .from('points')
            .select('user_id_hash, nickname')
            .in('user_id_hash', userIds);
            
        const userMap = new Map(users?.map(u => [u.user_id_hash, u.nickname]) || []);

        return ballots.map(b => ({
            userIdHash: b.user_id_hash,
            nickname: userMap.get(b.user_id_hash) || `익명(${b.user_id_hash.substring(0,4)})`, // 닉네임 없으면 ID 일부 표시
            amount: b.amount,
            optionId: b.option_id,
            timestamp: b.created_at
        }));
    }

    // [New] 투표 기록 가져오기
    public async getVoteHistory() {
        const { data: votes, error } = await supabase
            .from('votes')
            .select('*') // 옵션 조인 없이 가볍게
            .eq('channel_id', this.bot.getChannelId())
            .eq('status', 'ended')
            .order('created_at', { ascending: false })
            .limit(20);
            
        if (error) console.error('[VoteManager] History Error:', error);
        return votes || [];
    }

    // [New] 투표 참여자 중 추첨
    public async pickWinner(voteId: string, optionId: string | null, count: number) {
        let query = supabase.from('vote_ballots').select('user_id_hash').eq('vote_id', voteId);
        if (optionId) query = query.eq('option_id', optionId);
        
        const { data: candidates } = await query;
        if (!candidates || candidates.length === 0) return [];

        // 중복 제거
        const uniqueUsers = Array.from(new Set(candidates.map(c => c.user_id_hash)));
        const winnersId = [];
        
        for (let i = 0; i < count; i++) {
            if (uniqueUsers.length === 0) break;
            const idx = Math.floor(Math.random() * uniqueUsers.length);
            winnersId.push(uniqueUsers[idx]);
            uniqueUsers.splice(idx, 1);
        }

        // 닉네임 조회
        const { data: users } = await supabase
            .from('points')
            .select('user_id_hash, nickname')
            .in('user_id_hash', winnersId);
            
        const userMap = new Map(users?.map(u => [u.user_id_hash, u.nickname]) || []);
        
        return winnersId.map(id => ({
            userIdHash: id,
            nickname: userMap.get(id) || `익명(${id.substring(0,4)})`
        }));
    }

    // 채팅으로 투표 참여 (!투표 1)
    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active' || this.currentVote.mode !== 'normal') return;

        const msg = chat.message.trim();
        if (!msg.startsWith('!투표')) return;

        const selection = parseInt(msg.split(' ')[1]);
        if (isNaN(selection) || selection < 1 || selection > this.currentVote.options.length) return;

        const optionIndex = selection - 1;
        const option = this.currentVote.options[optionIndex];
        const userId = chat.profile.userIdHash;

        const { data: exist } = await supabase
            .from('vote_ballots')
            .select('id')
            .eq('vote_id', this.currentVote.id)
            .eq('user_id_hash', userId)
            .single();

        if (exist) return; 

        await supabase.from('vote_ballots').insert({
            vote_id: this.currentVote.id,
            user_id_hash: userId,
            option_id: option.id,
            amount: 1
        });

        option.count++;
        this.currentVote.totalParticipants++;
        
        await supabase.rpc('increment_vote_option', { row_id: option.id, x: 1 });
        
        this.notify();
    }

    // 후원으로 투표 참여
    public async handleDonation(donation: DonationEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active' || this.currentVote.mode !== 'donation') return;
        
        const msg = donation.message || '';
        const match = msg.match(/!투표\s+(\d+)/);
        if (!match) return;

        const selection = parseInt(match[1]);
        if (selection < 1 || selection > this.currentVote.options.length) return;

        const optionIndex = selection - 1;
        const option = this.currentVote.options[optionIndex];
        const amount = donation.payAmount || 0;

        await supabase.from('vote_ballots').insert({
            vote_id: this.currentVote.id,
            user_id_hash: donation.profile?.userIdHash || 'unknown',
            option_id: option.id,
            amount: amount
        });

        option.count += amount;
        this.currentVote.totalParticipants++; 
        
        await supabase.rpc('increment_vote_option', { row_id: option.id, x: amount });

        this.notify();
    }
}