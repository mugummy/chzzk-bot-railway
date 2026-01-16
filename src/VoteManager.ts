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
    private endedVotes: Vote[] = []; // [New] 메모리 기록 보관용
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
        const tempId = `vote_${Date.now()}`;
        
        this.currentVote = {
            id: tempId, 
            title,
            status: 'ready',
            mode,
            options: options.map((label, i) => ({ id: `opt_${i}`, label: String(label), count: 0 })),
            totalParticipants: 0
        };
        
        this.notify();

        // 2. DB 비동기 저장
        try {
            const { data: voteData, error } = await supabase
                .from('votes')
                .insert({ channel_id: this.bot.getChannelId(), title, mode, status: 'ready' })
                .select()
                .single();

            if (error) throw error;
            if (voteData) {
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
                
                if (optionsData && optionsData.length > 0) {
                    this.currentVote.options = optionsData.map(o => ({ id: o.id, label: o.label, count: 0 }));
                }
                
                this.notify();
            }
        } catch (err: any) {
            console.error('[VoteManager] DB Error in createVote:', err);
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
        
        if (this.bot.chat && this.bot.settings.getSettings().chatEnabled) {
            const modeText = this.currentVote.mode === 'normal' ? '일반 투표(1인 1표)' : '후원 투표(금액 비례)';
            const optionsText = this.currentVote.options.map((o: any, i: number) => {
                const label = typeof o === 'string' ? o : (o.label || '항목');
                return `${i+1}. ${label}`;
            }).join(' / ');
            
            const msg = `📢 [진행 중] ${this.currentVote.title}\n` + 
                        `📝 항목: ${optionsText}\n` + 
                        `👉 참여 방법: '!투표 번호' (예: !투표 1)`;
            this.bot.chat.sendChat(msg);
        }
        
        this.notify();
    }

    // 투표 종료
    public async endVote() {
        if (!this.currentVote) return;
        this.currentVote.status = 'ended';
        
        // 1. DB 업데이트 시도
        try {
            await supabase.from('votes').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', this.currentVote.id);
        } catch(e) { console.error('EndVote DB Error:', e); }

        // 2. 메모리 기록에 저장
        if (!this.endedVotes.find(v => v.id === this.currentVote?.id)) {
            this.endedVotes.unshift({ ...this.currentVote });
        }
        
        // 채팅 알림
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

    // 투표 초기화
    public async resetVote() {
        this.currentVote = null;
        this.bot.overlayManager?.setView('none');
        this.notify();
    }

    // 투표 삭제
    public async deleteVote(voteId: string) {
        await supabase.from('votes').delete().eq('id', voteId);
        if (this.currentVote?.id === voteId) {
            this.currentVote = null;
        }
        this.endedVotes = this.endedVotes.filter(v => v.id !== voteId);
        this.notify();
    }

    // 투표자 명단 가져오기
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
            nickname: userMap.get(b.user_id_hash) || `익명(${b.user_id_hash.substring(0,4)})`,
            amount: b.amount,
            optionId: b.option_id,
            timestamp: b.created_at
        }));
    }

    // 투표 기록 가져오기 (DB + 메모리 병합)
    public async getVoteHistory() {
        let dbVotes: any[] = [];
        try {
            const { data, error } = await supabase
                .from('votes')
                .select('*')
                .eq('channel_id', this.bot.getChannelId())
                .eq('status', 'ended')
                .order('created_at', { ascending: false })
                .limit(20);
            if (!error && data) dbVotes = data;
        } catch(e) {}

        const dbIds = new Set(dbVotes.map(v => v.id));
        const missingInMemory = this.endedVotes.filter(v => !dbIds.has(v.id));
        
        return [...missingInMemory, ...dbVotes];
    }

    // 투표 참여자 중 추첨 (필터 지원)
    public async pickWinner(voteId: string, optionId: string | null, count: number, filter: 'all' | 'win' | 'lose' = 'all') {
        // 1. 투표 정보 및 옵션 가져오기 (승자/패자 판별용)
        // 메모리에 있으면 메모리 우선
        let vote: any = this.currentVote?.id === voteId ? this.currentVote : this.endedVotes.find(v => v.id === voteId);
        
        if (!vote) {
            // DB 조회 (options 포함)
            const { data } = await supabase.from('votes').select('*, vote_options(*)').eq('id', voteId).single();
            vote = data;
        }
        
        if (!vote) return [];

        let targetOptionIds: string[] = [];
        // options가 없을 경우 대비 (DB 조회 시 vote_options)
        const options = vote.options || vote.vote_options || [];

        if (filter === 'all' || options.length === 0) {
            // 전체 대상
        } else {
            const sortedOptions = [...options].sort((a: any, b: any) => b.count - a.count);
            const maxCount = sortedOptions[0].count;
            
            if (filter === 'win') {
                targetOptionIds = sortedOptions.filter((o: any) => o.count === maxCount).map((o: any) => o.id);
            } else if (filter === 'lose') {
                const minCount = sortedOptions[sortedOptions.length - 1].count;
                targetOptionIds = sortedOptions.filter((o: any) => o.count === minCount).map((o: any) => o.id);
            }
        }

        // 2. 투표자 목록 가져오기
        let query = supabase.from('vote_ballots').select('user_id_hash, option_id').eq('vote_id', voteId);
        if (targetOptionIds.length > 0) {
            query = query.in('option_id', targetOptionIds);
        } else if (optionId) {
            query = query.eq('option_id', optionId);
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

    // 채팅으로 투표 참여
    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote || this.currentVote.status !== 'active' || this.currentVote.mode !== 'normal') return;

        const msg = chat.message.trim();
        if (!msg.startsWith('!투표')) return;

        // !투표 단독 입력 시 도움말
        if (msg === '!투표') {
            // (BotInstance에서 처리하도록 위임했으므로 여기선 스킵하거나 중복 처리 방지)
            return;
        }

        const selection = parseInt(msg.split(' ')[1]);
        if (isNaN(selection) || selection < 1 || selection > this.currentVote.options.length) return;

        const optionIndex = selection - 1;
        const option = this.currentVote.options[optionIndex];
        const userId = chat.profile.userIdHash;

        const { data: exist } = await supabase.from('vote_ballots').select('id').eq('vote_id', this.currentVote.id).eq('user_id_hash', userId).single();
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
