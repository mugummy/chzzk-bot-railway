import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface VoteOption {
    id: string;
    text: string;
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
}

export class VoteManager {
    private currentVote: VoteSession | null = null;
    private votedUsers: Set<string> = new Set();
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('voteStateUpdate', this.getState());
        this.bot.saveAll();
    }

    public setCurrentVote(vote: VoteSession) {
        this.currentVote = vote;
    }

    public createVote(question: string, options: VoteOption[], settings: any) {
        // [수정] 옵션이 없거나 질문이 비어있으면 생성 거부
        if (!question || !options || options.length < 2) return;

        this.currentVote = {
            id: `vote_${Date.now()}`,
            question,
            options,
            results: options.reduce((acc, opt) => ({ ...acc, [opt.id]: 0 }), {}),
            isActive: false,
            settings,
            startTime: null,
            totalVotes: 0
        };
        this.votedUsers.clear();
        this.notify();
    }

    public startVote() {
        if (this.currentVote) {
            this.currentVote.isActive = true;
            this.currentVote.startTime = Date.now();
            this.notify();
            if (this.bot.chat) {
                const opts = this.currentVote.options.map((o, i) => `${i+1}. ${o.text}`).join(' / ');
                this.bot.chat.sendChat(`📊 투표 시작: ${this.currentVote.question} [ ${opts} ] - 채팅으로 번호를 입력하세요!`);
            }
        }
    }

    public endVote() {
        if (this.currentVote) {
            this.currentVote.isActive = false;
            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 종료! 총 ${this.currentVote.totalVotes}표가 집계되었습니다.`);
        }
    }

    public resetVote() {
        this.currentVote = null;
        this.votedUsers.clear();
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const msg = chat.message.trim();
        
        // 숫자 투표 (1, 2, 3...)
        const optionIndex = parseInt(msg) - 1;
        if (!isNaN(optionIndex) && this.currentVote.options[optionIndex]) {
            this.castVote(chat.profile.userIdHash, this.currentVote.options[optionIndex].id);
        }
    }

    public async handleDonation(donation: DonationEvent) {
        // 추후 후원 투표 기능 확장 가능
    }

    private castVote(userId: string, optionId: string) {
        if (!this.currentVote || this.votedUsers.has(userId)) return;
        this.currentVote.results[optionId]++;
        this.currentVote.totalVotes++;
        this.votedUsers.add(userId);
        this.notify();
    }

    public getState() {
        return { currentVote: this.currentVote };
    }
}
