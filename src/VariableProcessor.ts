import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

/**
 * VariableProcessor: 모든 특수 함수(/user, /since, /dday 등)를 실시간 데이터로 치환합니다.
 */
export class VariableProcessor {
    constructor(private bot: BotInstance) {}

    public async process(text: string, context: { chat: ChatEvent, commandState?: any }): Promise<string> {
        let result = text;

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

        // [3] 시간 및 기간 관련
        if (live?.openDate) {
            result = result.replace(/\/uptime/g, this.calculateUptime(live.openDate));
        }

        // 팔로우 기간 (/since)
        if (context.chat.profile.badge?.imageUrl?.includes('subscribe')) {
            result = result.replace(/\/since/g, "구독 중인 시청자"); // 실제 API 호출 필요 시 확장 가능
        } else {
            result = result.replace(/\/since/g, "팔로우 중");
        }

        // 디데이 (/dday-YYYY-MM-DD)
        const ddayMatch = result.match(/\/dday-(\d{4}-\d{2}-\d{2})/);
        if (ddayMatch) {
            const targetDate = new Date(ddayMatch[1]).getTime();
            const diff = Math.floor((Date.now() - targetDate) / (1000 * 60 * 60 * 24));
            result = result.replace(ddayMatch[0], `${Math.abs(diff)}`);
        }

        // [4] 통계 및 카운터
        if (context.commandState?.totalCount !== undefined) {
            result = result.replace(/\/count/g, String(context.commandState.totalCount));
        }

        // [5] 랜덤 함수 (/random)
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