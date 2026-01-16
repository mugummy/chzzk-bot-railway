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
        
        // 1. 메모리 객체 우선 생성 (UI 반응성 보장)
        // 임시 ID 생성
        const tempId = `vote_${Date.now()}`;
        
        this.currentVote = {
            id: tempId, 
            title,
            status: 'ready',
            mode,
            options: options.map((label, i) => ({ id: `opt_${i}`, label: String(label), count: 0 })),
            totalParticipants: 0
        };
        
        // UI 즉시 갱신
        this.notify();

        // 2. DB 비동기 저장 (실패해도 UI는 유지)
        try {
            const { data: voteData, error } = await supabase
                .from('votes')
                .insert({ channel_id: this.bot.getChannelId(), title, mode, status: 'ready' })
                .select()
                .single();

            if (error) throw error;
            if (voteData) {
                // DB ID로 교체
                this.currentVote.id = voteData.id;
                
                const optionInserts = options.map(label => ({
                    vote_id: voteData.id,
                    label: String(label), 
                    count: 0
                }));

                const { data: optionsData, error: optError } = await supabase
                    .from('vote_options')
                    .insert(optionInserts)
                    .select();
                
                if (optError) console.error('[VoteManager] Option DB Error:', optError);
                
                // 옵션 ID 교체 (DB 데이터가 있으면)
                if (optionsData && optionsData.length > 0) {
                    this.currentVote.options = optionsData.map(o => ({ id: o.id, label: o.label, count: 0 }));
                }
                
                // ID 교체 후 다시 알림
                this.notify();
            }
        } catch (err: any) {
            console.error('[VoteManager] DB Error in createVote:', err);
            // DB 저장이 실패했더라도 메모리 상태는 유지하여 봇이 죽거나 UI가 사라지지 않게 함
            // 단, 서버 재시작 시 데이터는 날아감
            if (err.code === 'PGRST205' || err.code === 'PGRST204') {
                console.warn('[VoteManager] 스키마 캐시 문제로 DB 저장 실패. 메모리 모드로 동작합니다.');
            }
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

    // [New] 투표 참여자 중 추첨 (필터 지원)
    public async pickWinner(voteId: string, optionId: string | null, count: number, filter: 'all' | 'win' | 'lose' = 'all') {
        // 1. 투표 정보 및 옵션 가져오기 (승자/패자 판별용)
        const { data: vote } = await supabase.from('votes').select('*, vote_options(*)').eq('id', voteId).single();
        if (!vote) return [];

        let targetOptionIds: string[] = [];

        if (filter === 'all') {
            // 전체 대상
        } else {
            // 득표수 기준 정렬
            const sortedOptions = vote.vote_options.sort((a: any, b: any) => b.count - a.count);
            const maxCount = sortedOptions[0].count;
            
            if (filter === 'win') {
                // 최다 득표 항목들 (동점자 포함)
                targetOptionIds = sortedOptions.filter((o: any) => o.count === maxCount).map((o: any) => o.id);
            } else if (filter === 'lose') {
                // [Fix] 최소 득표 항목들 (꼴등)
                const minCount = sortedOptions[sortedOptions.length - 1].count;
                targetOptionIds = sortedOptions.filter((o: any) => o.count === minCount).map((o: any) => o.id);
            }
        }

        // 2. 투표자 목록 가져오기
        let query = supabase.from('vote_ballots').select('user_id_hash, option_id').eq('vote_id', voteId);
        if (targetOptionIds.length > 0) {
            query = query.in('option_id', targetOptionIds);
        } else if (optionId) {
            query = query.eq('option_id', optionId); // 특정 옵션 지정 시 (기존 호환)
        }
        
        const { data: candidates } = await query;
        if (!candidates || candidates.length === 0) return [];

        // 3. 추첨 (중복 제거)
        const uniqueUsers = Array.from(new Set(candidates.map(c => c.user_id_hash)));
        const winnersId = [];
        
        for (let i = 0; i < count; i++) {
            if (uniqueUsers.length === 0) break;
            const idx = Math.floor(Math.random() * uniqueUsers.length);
            winnersId.push(uniqueUsers[idx]);
            uniqueUsers.splice(idx, 1);
        }

        // 4. 닉네임 조회
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
        const msg = chat.message.trim();
        if (!msg.startsWith('!투표')) return;

        // [New] !투표 단독 입력 시 도움말 또는 현재 상태
        if (msg === '!투표') {
            if (this.currentVote && this.currentVote.status === 'active') {
                const optionsText = this.currentVote.options.map((o: any, i: number) => `${i+1}. ${o.label}`).join(' / ');
                const msg = `📢 [진행 중] ${this.currentVote.title}\n` +
                            `📝 항목: ${optionsText}\n` +
                            `👉 참여 방법: '!투표 번호' (예: !투표 1)`;
                this.bot.chat?.sendChat(msg);
            } else {
                const msg = `🗳️ [투표 도움말]\n` +
                            `- 현재 진행 중인 투표가 없습니다.\n` +
                            `- 스트리머가 투표를 시작하면 '!투표 [번호]'로 참여할 수 있습니다.\n` +
                            `- 예시: 1번 항목에 투표하려면 '!투표 1' 입력`;
                this.bot.chat?.sendChat(msg);
            }
            return;
        }

        if (!this.currentVote || this.currentVote.status !== 'active' || this.currentVote.mode !== 'normal') return;

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