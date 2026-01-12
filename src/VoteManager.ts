import { ChatEvent, ChzzkChat } from 'chzzk';
import { ChatBot } from './Bot';
import { Vote, VoterChoice } from './DataManager';
import { v4 as uuidv4 } from 'uuid';

export class VoteManager {
    private currentVote: Vote | null = null;
    private votes: Vote[] = [];
    private bot: ChatBot;
    private onStateChangeCallback: () => void = () => {};
    private voteTimer: NodeJS.Timeout | null = null;

    constructor(bot: ChatBot, initialVotes: Vote[]) {
        this.bot = bot;
        this.votes = initialVotes || [];
        // 기존에 활성화된 투표가 있으면 비활성화
        this.votes.forEach(vote => {
            if (vote.isActive) {
                console.log(`[VoteManager] Deactivating old active vote: ${vote.question}`);
                vote.isActive = false;
            }
        });
        this.currentVote = null; // 초기화 시 현재 투표 없음
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notifyStateChange() {
        this.onStateChangeCallback();
        this.bot.saveAllData();
    }

    public getState() {
        // currentVote의 status 결정
        let currentVoteWithStatus = null;
        if (this.currentVote) {
            currentVoteWithStatus = {
                ...this.currentVote,
                status: this.currentVote.isActive ? 'active' : (this.currentVote.endTime ? 'ended' : 'created')
            };
        }
        return {
            currentVote: currentVoteWithStatus,
            // 종료된 투표 중 currentVote가 아닌 것만 기록에 표시
            votesHistory: this.votes.filter(v => !v.isActive && v.endTime && v.id !== this.currentVote?.id)
        };
    }

    public createVote(question: string, options: string[], durationSeconds: number): { success: boolean; message?: string; vote?: Vote } {
        console.log(`[VoteManager] Creating vote - Question: "${question}", Duration: ${durationSeconds} (type: ${typeof durationSeconds}), Options: ${options.length}`);

        // 기존 활성 투표가 있으면 에러 반환 (자동 종료하지 않음)
        if (this.currentVote && this.currentVote.isActive) {
            console.log(`[VoteManager] Cannot create vote - active vote exists`);
            return { success: false, message: '이미 진행 중인 투표가 있습니다. 현재 투표를 종료 후 다시 시도해주세요.' };
        }

        // 새 투표 생성 시 기존 종료된 투표가 있으면 기록으로 이동 (currentVote 해제)
        if (this.currentVote && !this.currentVote.isActive) {
            console.log(`[VoteManager] Moving ended vote to history: ${this.currentVote.question}`);
            this.currentVote = null;
        }
        
        if (options.length < 2) {
            return { success: false, message: '투표 항목은 최소 2개 이상이어야 합니다.' };
        }
        // duration 검증
        const validDuration = parseInt(String(durationSeconds));
        if (isNaN(validDuration) || validDuration < 10) {
            console.log(`[VoteManager] Invalid duration: ${durationSeconds} -> ${validDuration}`);
            return { success: false, message: '투표 시간은 최소 10초 이상이어야 합니다.' };
        }
        durationSeconds = validDuration;

        console.log(`[VoteManager] Creating new vote: "${question}" with duration: ${durationSeconds}s`);

        const newVote: Vote = {
            id: uuidv4(),
            question,
            options: options.map((text, index) => ({ id: String(index + 1), text })),
            results: {},
            isActive: false,
            durationSeconds,
            startTime: null,
            voters: [],
            voterChoices: []
        };

        newVote.options.forEach(opt => {
            newVote.results[opt.id] = 0;
        });

        this.currentVote = newVote;
        this.votes.push(newVote);
        this.notifyStateChange();
        console.log(`[VoteManager] Vote created successfully with ID: ${newVote.id}`);
        return { success: true, vote: newVote };
    }

    public startVote(): { success: boolean; message?: string } {
        if (!this.currentVote) {
            return { success: false, message: '시작할 투표가 없습니다. 먼저 투표를 생성해주세요.' };
        }
        if (this.currentVote.isActive) {
            return { success: false, message: '이미 투표가 진행 중입니다.' };
        }

        console.log(`[VoteManager] Starting vote with duration: ${this.currentVote.durationSeconds} seconds`);
        
        this.currentVote.isActive = true;
        this.currentVote.startTime = Date.now();
        this.currentVote.voters = [];
        this.currentVote.voterChoices = [];
        this.currentVote.options.forEach(opt => {
            this.currentVote!.results[opt.id] = 0;
        });

        const timeoutDuration = this.currentVote.durationSeconds * 1000;
        console.log(`[VoteManager] Setting timer for ${timeoutDuration}ms`);
        
        this.voteTimer = setTimeout(() => {
            console.log(`[VoteManager] Vote timer expired, ending vote`);
            this.endVote();
        }, timeoutDuration);

        this.notifyStateChange();
        return { success: true };
    }

    public endVote(): { success: boolean; message?: string; results?: { [optionId: string]: number } } {
        if (!this.currentVote || !this.currentVote.isActive) {
            console.log(`[VoteManager] endVote called but no active vote found`);
            return { success: false, message: '진행 중인 투표가 없습니다.' };
        }

        console.log(`[VoteManager] Ending vote: ${this.currentVote.question}`);

        this.currentVote.isActive = false;
        this.currentVote.endTime = Date.now();

        if (this.voteTimer) {
            clearTimeout(this.voteTimer);
            this.voteTimer = null;
        }

        // 결과 저장 (currentVote는 유지하여 추첨 가능하게 - 초기화/새 투표 생성 전까지 유지)
        const results = { ...this.currentVote.results };
        // this.currentVote = null; // 종료 후에도 currentVote 유지 (추첨을 위해)
        this.notifyStateChange();
        return { success: true, results };
    }

    public vote(userIdHash: string, optionId: string, nickname?: string): { success: boolean; message?: string } {
        if (!this.currentVote || !this.currentVote.isActive) {
            return { success: false, message: '현재 진행 중인 투표가 없습니다.' };
        }
        if (this.currentVote.voters.includes(userIdHash)) {
            return { success: false, message: '이미 투표에 참여하셨습니다.' };
        }
        if (!this.currentVote.options.some(opt => opt.id === optionId)) {
            return { success: false, message: '유효하지 않은 투표 항목입니다.' };
        }

        this.currentVote.results[optionId]++;
        this.currentVote.voters.push(userIdHash);
        
        // 투표자 선택 정보 저장
        this.currentVote.voterChoices.push({
            userIdHash,
            optionId,
            nickname: nickname || `사용자${userIdHash.substring(0, 8)}`
        });
        
        this.notifyStateChange();
        return { success: true, message: '투표가 완료되었습니다.' };
    }

    public resetVote(): { success: boolean; message?: string } {
        if (this.currentVote && this.currentVote.isActive) {
            return { success: false, message: '진행 중인 투표가 있습니다. 먼저 투표를 종료해주세요.' };
        }
        this.currentVote = null;
        this.notifyStateChange();
        return { success: true, message: '투표가 초기화되었습니다.' };
    }

    public clearHistory(): { success: boolean; message?: string } {
        // 현재 활성 투표는 유지하고, 완료된 투표 기록만 삭제
        this.votes = this.votes.filter(v => v.isActive);
        this.notifyStateChange();
        return { success: true, message: '투표 기록이 삭제되었습니다.' };
    }

    public deleteVote(voteId: string): { success: boolean; message?: string } {
        const initialLength = this.votes.length;
        this.votes = this.votes.filter(vote => vote.id !== voteId);
        if (this.votes.length < initialLength) {
            this.notifyStateChange();
            return { success: true };
        }
        return { success: false, message: "해당 투표를 찾을 수 없습니다." };
    }

    public getVotes(): Vote[] {
        return this.votes;
    }

    public drawWinner(count: number = 1, voteId?: string): { success: boolean; message?: string; winners?: VoterChoice[] } {
        let targetVote = voteId ? this.votes.find(v => v.id === voteId) : this.currentVote;
        
        if (!targetVote) {
            return { success: false, message: '추첨할 투표를 찾을 수 없습니다.' };
        }
        
        if (targetVote.isActive) {
            return { success: false, message: '진행 중인 투표에서는 추첨할 수 없습니다. 먼저 투표를 종료해주세요.' };
        }
        
        if (targetVote.voterChoices.length === 0) {
            return { success: false, message: '투표 참여자가 없어 추첨할 수 없습니다.' };
        }
        
        if (count > targetVote.voterChoices.length) {
            count = targetVote.voterChoices.length;
        }
        
        // 무작위로 당첨자 선택
        const shuffled = [...targetVote.voterChoices].sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, count);
        
        return { 
            success: true, 
            winners,
            message: `${count}명의 당첨자가 추첨되었습니다.`
        };
    }

    public drawWinnerByOption(optionId: string, count: number = 1, voteId?: string): { success: boolean; message?: string; winners?: VoterChoice[] } {
        let targetVote = voteId ? this.votes.find(v => v.id === voteId) : this.currentVote;
        
        if (!targetVote) {
            return { success: false, message: '추첨할 투표를 찾을 수 없습니다.' };
        }
        
        if (targetVote.isActive) {
            return { success: false, message: '진행 중인 투표에서는 추첨할 수 없습니다. 먼저 투표를 종료해주세요.' };
        }
        
        const optionVoters = targetVote.voterChoices.filter(choice => choice.optionId === optionId);
        
        if (optionVoters.length === 0) {
            const option = targetVote.options.find(opt => opt.id === optionId);
            const optionText = option ? option.text : optionId;
            return { success: false, message: `"${optionText}" 항목에 투표한 사람이 없어 추첨할 수 없습니다.` };
        }
        
        if (count > optionVoters.length) {
            count = optionVoters.length;
        }
        
        // 무작위로 당첨자 선택
        const shuffled = [...optionVoters].sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, count);
        
        const option = targetVote.options.find(opt => opt.id === optionId);
        const optionText = option ? option.text : optionId;
        
        return { 
            success: true, 
            winners,
            message: `"${optionText}" 항목에서 ${count}명의 당첨자가 추첨되었습니다.`
        };
    }

    public async getVoterNicknames(userIdHashes: string[]): Promise<{ userIdHash: string; nickname: string; }[]> {
        const nicknames: { userIdHash: string; nickname: string; }[] = [];
        for (const userIdHash of userIdHashes) {
            const user = this.bot.pointManager.getPointsData()[userIdHash];
            if (user) {
                nicknames.push({ userIdHash, nickname: user.nickname });
            } else {
                // 포인트 데이터에 없는 경우 기본 닉네임 사용
                nicknames.push({ userIdHash, nickname: `사용자${userIdHash.substring(0, 8)}` });
            }
        }
        return nicknames;
    }

    private resumeVoteTimer() {
        if (this.currentVote && this.currentVote.isActive && this.currentVote.startTime) {
            const elapsedTime = (Date.now() - this.currentVote.startTime) / 1000;
            const remainingTime = this.currentVote.durationSeconds - elapsedTime;

            if (remainingTime > 0) {
                this.voteTimer = setTimeout(() => {
                    this.endVote();
                }, remainingTime * 1000);
            } else {
                this.endVote();
            }
        }
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat): Promise<void> {
        const safeSendChat = (message: string) => {
            try {
                chzzkChat.sendChat(message);
            } catch (e) {
                console.log('[VoteManager] Failed to send chat (not logged in):', message);
            }
        };
        
        const message = chat.message.trim();
        const parts = message.split(' ');
        const command = parts[0];

        if (command === '!투표') {
            if (parts.length === 1) {
                safeSendChat('투표 명령어: !투표 [항목번호] (투표 참여), !투표 생성 [질문] [항목1] [항목2] ... [시간(초)], !투표 시작, !투표 종료, !투표 현황, !투표 초기화, !투표 추첨 [인원수], !투표 추첨 [항목번호] [인원수]');
            
            } else if (parts[1] === '시작') {
                if (chat.profile.userRoleCode !== 'streamer' && chat.profile.userRoleCode !== 'manager') {
                    safeSendChat('투표 시작은 스트리머와 매니저만 가능합니다.');
                    return;
                }
                const result = this.startVote();
                if (result.success) {
                    const optionsText = this.currentVote!.options.map(opt => `${opt.id}. ${opt.text}`).join(', ');
                    safeSendChat(`투표가 시작되었습니다! "${this.currentVote!.question}" 항목: ${optionsText} (${this.currentVote!.durationSeconds}초) !투표 [항목번호] 로 참여해주세요.`);
                } else {
                    safeSendChat(`투표 시작 실패: ${result.message}`);
                }
            } else if (parts[1] === '종료') {
                if (chat.profile.userRoleCode !== 'streamer' && chat.profile.userRoleCode !== 'manager') {
                    safeSendChat('투표 종료는 스트리머와 매니저만 가능합니다.');
                    return;
                }
                const result = this.endVote();
                if (result.success && result.results) {
                    const totalVotes = Object.values(result.results).reduce((sum, count) => sum + count, 0);
                    let response = `투표가 종료되었습니다! "${this.currentVote!.question}" 결과:\n`;
                    this.currentVote!.options.forEach(opt => {
                        const count = result.results![opt.id];
                        const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : 0;
                        response += `${opt.text}: ${count}표 (${percentage}%)\n`;
                    });
                    safeSendChat(response);
                } else {
                    safeSendChat(`투표 종료 실패: ${result.message}`);
                }
            } else if (parts[1] === '현황') {
                if (!this.currentVote || !this.currentVote.isActive) {
                    safeSendChat('현재 진행 중인 투표가 없습니다.');
                    return;
                }
                const totalVotes = Object.values(this.currentVote.results).reduce((sum, count) => sum + count, 0);
                let response = `현재 투표 현황: "${this.currentVote.question}"\n`;
                this.currentVote.options.forEach(opt => {
                    const count = this.currentVote!.results[opt.id];
                    const percentage = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : 0;
                    response += `${opt.text}: ${count}표 (${percentage}%)\n`;
                });
                const elapsedTime = (Date.now() - this.currentVote.startTime!) / 1000;
                const remainingTime = this.currentVote.durationSeconds - elapsedTime;
                response += `남은 시간: ${Math.max(0, Math.floor(remainingTime))}초`;
                safeSendChat(response);
            } else if (parts[1] === '초기화') {
                if (chat.profile.userRoleCode !== 'streamer' && chat.profile.userRoleCode !== 'manager') {
                    safeSendChat('투표 초기화는 스트리머와 매니저만 가능합니다.');
                    return;
                }
                const result = this.resetVote();
                safeSendChat(result.message!); 
            } else if (parts[1] === '추첨') {
                if (chat.profile.userRoleCode !== 'streamer' && chat.profile.userRoleCode !== 'manager') {
                    safeSendChat('투표 추첨은 스트리머와 매니저만 가능합니다.');
                    return;
                }
                
                if (parts.length === 3) {
                    // !투표 추첨 [인원수]
                    const count = parseInt(parts[2]) || 1;
                    const result = this.drawWinner(count);
                    if (result.success && result.winners) {
                        const winnerNames = result.winners.map(w => w.nickname).join(', ');
                        safeSendChat(`🎉 투표 추첨 결과: ${winnerNames}`);
                    } else {
                        safeSendChat(`추첨 실패: ${result.message}`);
                    }
                } else if (parts.length === 4) {
                    // !투표 추첨 [항목번호] [인원수]
                    const optionId = parts[2];
                    const count = parseInt(parts[3]) || 1;
                    const result = this.drawWinnerByOption(optionId, count);
                    if (result.success && result.winners) {
                        const winnerNames = result.winners.map(w => w.nickname).join(', ');
                        safeSendChat(`🎉 ${result.message} 당첨자: ${winnerNames}`);
                    } else {
                        safeSendChat(`추첨 실패: ${result.message}`);
                    }
                } else {
                    safeSendChat('사용법: !투표 추첨 [인원수] 또는 !투표 추첨 [항목번호] [인원수]');
                }
            } else {
                const optionId = parts[1];
                const result = this.vote(chat.profile.userIdHash, optionId, chat.profile.nickname);
                // 실패 시에만 채팅으로 알림 (성공 시에는 조용히 처리)
                if (!result.success && result.message) {
                    safeSendChat(result.message);
                }
            }
        }
    }
}
