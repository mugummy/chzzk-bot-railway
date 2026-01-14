import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface VoteOption {
    id: string;
    text: string;
}

export interface Voter {
    userIdHash: string;
    nickname: string;
    optionId: string;
}

export interface VoteSession {
    id: string;
    question: string;
    options: VoteOption[];
    results: { [optionId: string]: number };
    isActive: boolean;
    settings: any;
    startTime: number | null;
    totalVotes: number;
    voters: Voter[];
}

/**
 * VoteManager: 실시간 투표 및 투표자 명단을 관리합니다.
 */
export class VoteManager {
    private currentVote: VoteSession | null = null;
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('voteStateUpdate', this.getState());
        this.bot.saveAll();
    }

    // [핵심] DB에서 불러온 투표 데이터를 세션에 주입하는 메서드 (복구됨)
    public setCurrentVote(vote: VoteSession) {
        this.currentVote = vote;
        // 초기화 시 notify는 호출하지 않음 (무한 루프 방지)
    }

    public createVote(question: string, options: VoteOption[], settings: any) {
        if (!question || !options || options.length < 2) return;

        this.currentVote = {
            id: `vote_${Date.now()}`,
            question,
            options,
            results: options.reduce((acc, opt) => ({ ...acc, [opt.id]: 0 }), {}),
            isActive: false,
            settings,
            startTime: null,
            totalVotes: 0,
            voters: []
        };
        this.notify();
    }

    public startVote() {
        if (this.currentVote) {
            this.currentVote.isActive = true;
            this.currentVote.startTime = Date.now();
            this.notify();
            if (this.bot.chat) {
                const opts = this.currentVote.options.map((o, i) => `${i+1}. ${o.text}`).join(' / ');
                this.bot.chat.sendChat(`📊 투표 시작: ${this.currentVote.question} [ ${opts} ]`);
            }
        }
    }

    public async endVote() {
        if (this.currentVote) {
            this.currentVote.isActive = false;
            
            // DB 로그 저장
            if (this.currentVote.voters.length > 0) {
                try {
                    const payload = this.currentVote.voters.map(v => ({
                        channel_id: this.bot.getChannelId(),
                        vote_id: this.currentVote!.id,
                        user_id_hash: v.userIdHash,
                        nickname: v.nickname,
                        option_id: v.optionId
                    }));
                    await supabase.from('vote_logs').insert(payload);
                } catch (e) {
                    console.error('[VoteManager] Log Save Error:', e);
                }
            }

            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 종료! 총 ${this.currentVote.totalVotes}표 집계 완료`);
        }
    }

    public resetVote() {
        this.currentVote = null;
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const msg = chat.message.trim();
        const optionIndex = parseInt(msg) - 1;
        
        if (!isNaN(optionIndex) && this.currentVote.options[optionIndex]) {
            const userId = chat.profile.userIdHash;
            // 중복 투표 체크
            if (!this.currentVote.voters.some(v => v.userIdHash === userId)) {
                const optionId = this.currentVote.options[optionIndex].id;
                this.currentVote.results[optionId]++;
                this.currentVote.totalVotes++;
                this.currentVote.voters.push({
                    userIdHash: userId,
                    nickname: chat.profile.nickname,
                    optionId: optionId
                });
                this.notify();
            }
        }
    }

    public getState() { return { currentVote: this.currentVote }; }
    
    public getVoters() { return this.currentVote?.voters || []; }
}