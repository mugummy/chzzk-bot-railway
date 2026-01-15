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
        console.log(`[VoteManager] Creating vote: ${title} (${mode}) for ${this.bot.getChannelId()}`);
        
        const { data: voteData, error } = await supabase
            .from('votes')
            .insert({ channel_id: this.bot.getChannelId(), title, mode, status: 'ready' })
            .select()
            .single();

        if (error) {
            console.error('[VoteManager] DB Error:', error);
            throw new Error(`투표 생성 실패: ${error.message}`);
        }
        if (!voteData) throw new Error('투표 생성 실패: 데이터 없음');

        const optionInserts = options.map(label => ({
            vote_id: voteData.id,
            label,
            count: 0
        }));

        const { data: optionsData } = await supabase
            .from('vote_options')
            .insert(optionInserts)
            .select();

        this.currentVote = {
            id: voteData.id,
            title: voteData.title,
            status: 'ready',
            mode: voteData.mode,
            options: (optionsData || []).map(o => ({ id: o.id, label: o.label, count: 0 })),
            totalParticipants: 0
        };
        this.notify();
    }

    // 투표 시작
    public async startVote() {
        if (!this.currentVote) return;
        this.currentVote.status = 'active';
        await supabase.from('votes').update({ status: 'active' }).eq('id', this.currentVote.id);
        
        // [Fix] 상세 채팅 알림
        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            const modeText = this.currentVote.mode === 'normal' ? '일반 투표(1인 1표)' : '후원 투표(금액 비례)';
            
            // options가 문자열 배열일 수도, 객체 배열일 수도 있음. 방어 코드 추가.
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
            
            // 결과 요약 (참여자가 있을 때만)
            if (this.currentVote.totalParticipants > 0 && this.currentVote.options.length > 0) {
                const topOption = this.currentVote.options.reduce((prev, current) => (prev.count > current.count) ? prev : current);
                this.bot.chat.sendChat(`🏆 최다 득표: ${topOption.label} (${topOption.count}표)`);
            } else {
                this.bot.chat.sendChat(`💨 참여자가 없어 결과가 없습니다.`);
            }
        }

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

    // [New] 투표 초기화
    public async resetVote() {
        this.currentVote = null;
        this.bot.overlayManager?.setView('none');
        this.notify();
    }

    // [New] 투표자 명단 가져오기
    public async getBallots(voteId: string) {
        const { data: ballots } = await supabase
            .from('vote_ballots')
            .select(`user_id_hash, amount, created_at, option_id`)
            .eq('vote_id', voteId);
            
        if (!ballots) return [];

        const { data: users } = await supabase
            .from('points')
            .select('user_id_hash, nickname')
            .in('user_id_hash', ballots.map(b => b.user_id_hash));
            
        const userMap = new Map(users?.map(u => [u.user_id_hash, u.nickname]) || []);

        return ballots.map(b => ({
            userIdHash: b.user_id_hash,
            nickname: userMap.get(b.user_id_hash) || '익명',
            amount: b.amount,
            optionId: b.option_id,
            timestamp: b.created_at
        }));
    }

    // [New] 투표 기록 가져오기
    public async getVoteHistory() {
        const { data: votes } = await supabase
            .from('votes')
            .select(`*, vote_options(*)`)
            .eq('channel_id', this.bot.getChannelId())
            .eq('status', 'ended')
            .order('created_at', { ascending: false });
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
        const winners = [];
        
        for (let i = 0; i < count; i++) {
            if (uniqueUsers.length === 0) break;
            const idx = Math.floor(Math.random() * uniqueUsers.length);
            winners.push(uniqueUsers[idx]);
            uniqueUsers.splice(idx, 1);
        }

        // 닉네임 조회
        const { data: users } = await supabase
            .from('points')
            .select('user_id_hash, nickname')
            .in('user_id_hash', winners);
            
        return users || [];
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

        // DB에서 중복 투표 확인
        const { data: exist } = await supabase
            .from('vote_ballots')
            .select('id')
            .eq('vote_id', this.currentVote.id)
            .eq('user_id_hash', userId)
            .single();

        if (exist) return; // 이미 투표함

        // 투표 반영
        await supabase.from('vote_ballots').insert({
            vote_id: this.currentVote.id,
            user_id_hash: userId,
            option_id: option.id,
            amount: 1
        });

        // 메모리 상태 업데이트 (실시간성)
        option.count++;
        this.currentVote.totalParticipants++;
        
        // DB 카운트 업데이트 (비동기)
        await supabase.rpc('increment_vote_option', { row_id: option.id, x: 1 });
        
        this.notify();
    }

    // 후원으로 투표 참여
    public async handleDonation(donation: DonationEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active' || this.currentVote.mode !== 'donation') return;
        
        // 메시지에서 "!투표 N" 파싱
        const msg = donation.message || '';
        const match = msg.match(/!투표\s+(\d+)/);
        if (!match) return;

        const selection = parseInt(match[1]);
        if (selection < 1 || selection > this.currentVote.options.length) return;

        const optionIndex = selection - 1;
        const option = this.currentVote.options[optionIndex];
        const amount = donation.payAmount || 0;

        // 후원 투표는 중복 가능 (금액 누적)
        await supabase.from('vote_ballots').insert({
            vote_id: this.currentVote.id,
            user_id_hash: donation.profile?.userIdHash || 'unknown',
            option_id: option.id,
            amount: amount
        });

        option.count += amount;
        this.currentVote.totalParticipants++; // 참여 횟수 증가 (사람 수가 아님)
        
        // DB 카운트 업데이트
        await supabase.rpc('increment_vote_option', { row_id: option.id, x: amount });

        this.notify();
    }
}
