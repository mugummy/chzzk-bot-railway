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
        const { data: voteData, error } = await supabase
            .from('votes')
            .insert({ channel_id: this.bot.getChannelId(), title, mode, status: 'ready' })
            .select()
            .single();

        if (error || !voteData) throw new Error('투표 생성 실패');

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
        this.notify();
    }

    // 투표 종료
    public async endVote() {
        if (!this.currentVote) return;
        this.currentVote.status = 'ended';
        await supabase.from('votes').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', this.currentVote.id);
        this.notify();
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
