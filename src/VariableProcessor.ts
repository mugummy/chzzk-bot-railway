import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export class VariableProcessor {
    constructor(private bot: BotInstance) {}

    public async process(text: string, context: { chat: ChatEvent, commandState?: any, counterState?: any }): Promise<string> {
        let result = text;
        const userId = context.chat.profile.userIdHash;

        // [1] 시청자 관련
        result = result.replace(/\/user/g, context.chat.profile.nickname);
        
        // [2] 채널 및 라이브 관련
        const live = (this.bot as any).liveDetail;
        const channel = (this.bot as any).channel;
        
        result = result.replace(/\/channel/g, channel?.channelName || "스트리머");
        result = result.replace(/\/follower/g, channel?.followerCount?.toLocaleString() || "0");
        result = result.replace(/\/viewer/g, live?.concurrentUserCount?.toLocaleString() || "0");
        result = result.replace(/\/title/g, live?.liveTitle || "제목 없음");
        result = result.replace(/\/category/g, live?.category || "미지정");

        if (live?.openDate) result = result.replace(/\/uptime/g, this.calculateUptime(live.openDate));

        // [3] 카운터 처리 (/count, /countall)
        // 카운터 실행 시 (counterState 존재)
        if (context.counterState) {
            const userCount = context.counterState.userCounts?.[userId] || 0;
            const totalCount = context.counterState.count || 0;
            result = result.replace(/\/countall/g, String(totalCount)); // 전체 횟수
            result = result.replace(/\/count/g, String(userCount));    // 개인 횟수
        } 
        // 일반 명령어 실행 시 (commandState 존재)
        else if (context.commandState) {
            const userCount = context.commandState.userCounts?.[userId] || 0;
            const totalCount = context.commandState.totalCount || 0;
            result = result.replace(/\/countall/g, String(totalCount));
            result = result.replace(/\/count/g, String(userCount));
        }

        // [4] 랜덤 함수
        if (result.includes('/random')) {
            const parts = result.split('/random');
            result = parts[Math.floor(Math.random() * parts.length)].trim();
        }

        return result;
    }

    private calculateUptime(openDateStr: string): string {
        const openDate = new Date(openDateStr).getTime();
        const diff = Date.now() - openDate;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((diff % (1000 * 60)) / 1000);
        return `${hours}시간 ${mins}분 ${secs}초`;
    }
}