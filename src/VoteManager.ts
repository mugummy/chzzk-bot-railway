import { ChatEvent, DonationEvent } from 'chzzk';
import { supabase } from './supabase';

interface VoteOption {
    id: string;
    label: string;
    position: number;
    count: number;
    voters: { odHash: string; nickname: string; weight: number }[];
}

interface VoteSession {
    id: string;
    title: string;
    status: 'pending' | 'active' | 'ended';
    mode: 'chat' | 'donation';
    allowMultiple: boolean;
    options: VoteOption[];
    totalVotes: number;
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
}

export class VoteManager {
    private bot: any;
    private channelId: string;
    private currentVote: VoteSession | null = null;
    private votedUsers: Set<string> = new Set();
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};

    constructor(bot: any) {
        this.bot = bot;
        this.channelId = bot.getChannelId();
        this.loadActiveVote();
    }

    setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback('voteStateUpdate', this.getState());
    }

    getState() {
        if (!this.currentVote) {
            return { currentVote: null };
        }

        const sortedOptions = [...this.currentVote.options].sort((a, b) => b.count - a.count);
        const maxCount = Math.max(...sortedOptions.map(o => o.count), 1);

        return {
            currentVote: {
                ...this.currentVote,
                options: sortedOptions.map(opt => ({
                    ...opt,
                    percent: this.currentVote!.totalVotes > 0
                        ? ((opt.count / this.currentVote!.totalVotes) * 100).toFixed(1)
                        : '0.0',
                    barPercent: (opt.count / maxCount) * 100
                }))
            }
        };
    }

    private async loadActiveVote() {
        try {
            const { data: vote } = await supabase
                .from('votes')
                .select('*')
                .eq('channel_id', this.channelId)
                .eq('status', 'active')
                .single();

            if (vote) {
                const { data: options } = await supabase
                    .from('vote_options')
                    .select('*')
                    .eq('vote_id', vote.id)
                    .order('position');

                const { data: ballots } = await supabase
                    .from('vote_ballots')
                    .select('*')
                    .eq('vote_id', vote.id);

                const optionsWithVotes: VoteOption[] = (options || []).map(opt => {
                    const optBallots = (ballots || []).filter(b => b.option_id === opt.id);
                    return {
                        id: opt.id,
                        label: opt.label,
                        position: opt.position,
                        count: optBallots.reduce((sum, b) => sum + b.weight, 0),
                        voters: optBallots.map(b => ({ odHash: b.user_id_hash, nickname: b.nickname, weight: b.weight }))
                    };
                });

                this.currentVote = {
                    id: vote.id,
                    title: vote.title,
                    status: vote.status,
                    mode: vote.mode,
                    allowMultiple: vote.allow_multiple,
                    options: optionsWithVotes,
                    totalVotes: optionsWithVotes.reduce((sum, o) => sum + o.count, 0),
                    createdAt: vote.created_at,
                    startedAt: vote.started_at,
                    endedAt: vote.ended_at
                };

                this.votedUsers = new Set((ballots || []).map(b => b.user_id_hash));
            }
        } catch (e) {
            console.error('[VoteManager] Failed to load active vote:', e);
        }
    }

    async createVote(title: string, optionLabels: string[], mode: 'chat' | 'donation' = 'chat', allowMultiple: boolean = false) {
        try {
            // End any existing active vote
            if (this.currentVote && this.currentVote.status === 'active') {
                await this.endVote();
            }

            const { data: vote, error: voteError } = await supabase
                .from('votes')
                .insert({
                    channel_id: this.channelId,
                    title,
                    status: 'pending',
                    mode,
                    allow_multiple: allowMultiple
                })
                .select()
                .single();

            if (voteError || !vote) throw voteError;

            const optionsToInsert = optionLabels.map((label, idx) => ({
                vote_id: vote.id,
                label,
                position: idx + 1
            }));

            const { data: options, error: optError } = await supabase
                .from('vote_options')
                .insert(optionsToInsert)
                .select();

            if (optError) throw optError;

            this.currentVote = {
                id: vote.id,
                title: vote.title,
                status: 'pending',
                mode,
                allowMultiple,
                options: (options || []).map(opt => ({
                    id: opt.id,
                    label: opt.label,
                    position: opt.position,
                    count: 0,
                    voters: []
                })),
                totalVotes: 0,
                createdAt: vote.created_at
            };

            this.votedUsers.clear();
            this.notify();
            return this.currentVote;
        } catch (e) {
            console.error('[VoteManager] Failed to create vote:', e);
            throw e;
        }
    }

    async startVote() {
        if (!this.currentVote || this.currentVote.status === 'active') return;

        try {
            await supabase
                .from('votes')
                .update({ status: 'active', started_at: new Date().toISOString() })
                .eq('id', this.currentVote.id);

            this.currentVote.status = 'active';
            this.currentVote.startedAt = new Date().toISOString();
            this.notify();

            // Announce in chat
            if (this.bot.chat) {
                const optionText = this.currentVote.options.map((o, i) => `${i + 1}. ${o.label}`).join(' / ');
                await this.bot.chat.sendChat(`[투표 시작] ${this.currentVote.title}\n${optionText}\n채팅에 번호를 입력하세요!`);
            }
        } catch (e) {
            console.error('[VoteManager] Failed to start vote:', e);
        }
    }

    async endVote() {
        if (!this.currentVote || this.currentVote.status !== 'active') return;

        try {
            await supabase
                .from('votes')
                .update({ status: 'ended', ended_at: new Date().toISOString() })
                .eq('id', this.currentVote.id);

            this.currentVote.status = 'ended';
            this.currentVote.endedAt = new Date().toISOString();
            this.notify();

            // Announce winner in chat
            if (this.bot.chat && this.currentVote.options.length > 0) {
                const sorted = [...this.currentVote.options].sort((a, b) => b.count - a.count);
                const winner = sorted[0];
                await this.bot.chat.sendChat(`[투표 종료] "${winner.label}" 승리! (${winner.count}표 / 총 ${this.currentVote.totalVotes}표)`);
            }
        } catch (e) {
            console.error('[VoteManager] Failed to end vote:', e);
        }
    }

    async resetVote() {
        this.currentVote = null;
        this.votedUsers.clear();
        this.notify();
    }

    handleChat(chat: ChatEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active') return;
        if (this.currentVote.mode !== 'chat') return;

        const msg = chat.message.trim();
        const num = parseInt(msg);

        if (isNaN(num) || num < 1 || num > this.currentVote.options.length) return;

        const userIdHash = chat.profile.userIdHash;
        const nickname = chat.profile.nickname;

        // Check if already voted (when multiple not allowed)
        if (!this.currentVote.allowMultiple && this.votedUsers.has(userIdHash)) return;

        this.castVote(num - 1, userIdHash, nickname, 1);
    }

    handleDonation(donation: DonationEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active') return;
        if (this.currentVote.mode !== 'donation') return;

        const msg = (donation.message || '').trim();
        const num = parseInt(msg);

        if (isNaN(num) || num < 1 || num > this.currentVote.options.length) return;

        const userIdHash = donation.profile?.userIdHash || 'anonymous';
        const nickname = donation.profile?.nickname || '익명';
        const amount = (donation as any).payAmount || 1000;
        const weight = Math.floor(amount / 1000); // 1000원 = 1표

        if (weight < 1) return;

        this.castVote(num - 1, userIdHash, nickname, weight);
    }

    private async castVote(optionIndex: number, userIdHash: string, nickname: string, weight: number) {
        if (!this.currentVote) return;

        const option = this.currentVote.options[optionIndex];
        if (!option) return;

        try {
            await supabase.from('vote_ballots').insert({
                vote_id: this.currentVote.id,
                option_id: option.id,
                user_id_hash: userIdHash,
                nickname,
                weight
            });

            option.count += weight;
            option.voters.push({ odHash: userIdHash, nickname, weight });
            this.currentVote.totalVotes += weight;
            this.votedUsers.add(userIdHash);

            this.notify();
        } catch (e) {
            console.error('[VoteManager] Failed to cast vote:', e);
        }
    }

    async pickWinner(optionId: string): Promise<{ nickname: string; userIdHash: string } | null> {
        if (!this.currentVote) return null;

        const option = this.currentVote.options.find(o => o.id === optionId);
        if (!option || option.voters.length === 0) return null;

        const randomIndex = Math.floor(Math.random() * option.voters.length);
        const winner = option.voters[randomIndex];

        return { nickname: winner.nickname, userIdHash: winner.odHash };
    }

    async getVoteHistory(): Promise<any[]> {
        try {
            const { data } = await supabase
                .from('votes')
                .select('*, vote_options(*)')
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
