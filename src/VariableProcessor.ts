import { ChatEvent } from 'chzzk';
import { ChatBot } from './Bot';
import { Command } from './CommandManager';
import { Counter } from './CounterManager';

interface ProcessContext {
    chat?: ChatEvent;
    commandState?: Command['state'] | Counter['state'];
}

export class VariableProcessor {
    private bot: ChatBot;

    constructor(bot: ChatBot) {
        this.bot = bot;
    }

    private formatUptime(startTime: string | undefined): string {
        if (!startTime) return 'N/A';
        const start = new Date(startTime).getTime();
        const now = Date.now();
        let delta = Math.floor((now - start) / 1000);

        const days = Math.floor(delta / 86400);
        delta -= days * 86400;
        const hours = Math.floor(delta / 3600) % 24;
        delta -= hours * 3600;
        const minutes = Math.floor(delta / 60) % 60;

        let result = '';
        if (days > 0) result += `${days}일 `;
        if (hours > 0) result += `${hours}시간 `;
        if (minutes > 0) result += `${minutes}분`;
        return result.trim() || '방금';
    }

    public async process(text: string, context: ProcessContext = {}): Promise<string> {
        let processedText = text;
        const { chat, commandState } = context;
        const { liveDetail, channel } = this.bot;

        // Simple replacements from bot state
        if (chat) {
            processedText = processedText.replace(/{user}/g, chat.profile.nickname);
        }
        if (channel) {
            processedText = processedText.replace(/{channel}/g, channel.channelName);
            processedText = processedText.replace(/{follower}/g, channel.followerCount.toLocaleString());
        }
        if (liveDetail) {
            processedText = processedText.replace(/{title}/g, liveDetail.liveTitle);
            processedText = processedText.replace(/{category}/g, liveDetail.liveCategoryValue || '카테고리 없음');
            processedText = processedText.replace(/{viewer}/g, liveDetail.concurrentUserCount.toLocaleString());
            processedText = processedText.replace(/{uptime}/g, this.formatUptime(liveDetail.openDate));
        }

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');

        processedText = processedText.replace(/{date}/g, `${year}-${month}-${day}`);
        processedText = processedText.replace(/{time}/g, `${hour}:${minute}:${second}`);

        // {dday-YYYY-MM-DD}
        processedText = processedText.replace(/{dday-(\d{4}-\d{2}-\d{2})}/g, (match, dateStr) => {
            const targetDate = new Date(dateStr);
            if (isNaN(targetDate.getTime())) return '날짜 형식 오류';
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            targetDate.setHours(0, 0, 0, 0);
            const diffTime = targetDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) return 'D-Day';
            return diffDays > 0 ? `D-${diffDays}` : `D+${Math.abs(diffDays)}`;
        });

        // Functional replacements with parameters
        // {random(min,max)}
        processedText = processedText.replace(/{random\((\d+),(\d+)\)}/g, (match, min, max) => {
            const minNum = parseInt(min, 10);
            const maxNum = parseInt(max, 10);
            return (Math.floor(Math.random() * (maxNum - minNum + 1)) + minNum).toString();
        });

        // {any(item1,item2,...)}
        processedText = processedText.replace(/{any\(([^)]+)\)}/g, (match, items) => {
            const options = items.split(',').map((s: string) => s.trim());
            return options[Math.floor(Math.random() * options.length)];
        });

        if (processedText.includes('{since}')) {
            let startDateStr: string | undefined;
            if (chat) {
                if (chat.profile.userRoleCode === 'streamer') {
                    // 스트리머 본인인 경우, 현재 시간으로 설정하여 0초로 만듦
                    startDateStr = new Date().toISOString();
                } else if (this.bot.chat) { // Ensure chat client is available
                    try {
                        // 치지직 채팅 클라이언트를 통해 사용자 프로필 조회
                        const userProfile = await this.bot.chat.profile(chat.profile.userIdHash);
                        startDateStr = userProfile.streamingProperty?.following?.followDate;
                    } catch (e) {
                        console.error('Error fetching user profile for {since}:', e);
                    }
                } else {
                    console.warn('Chat client not available for {since} function.');
                }
            }

            let resultText = '팔로우 정보 없음';
            if (startDateStr) {
                const startDate = new Date(startDateStr);
                if (!isNaN(startDate.getTime())) {
                    const now = new Date();
                    let diffSeconds = Math.floor((now.getTime() - startDate.getTime()) / 1000);

                    if (diffSeconds < 0) diffSeconds = 0; // 미래 시간 방지

                    const years = Math.floor(diffSeconds / (365 * 24 * 60 * 60));
                    diffSeconds -= years * (365 * 24 * 60 * 60);
                    const months = Math.floor(diffSeconds / (30 * 24 * 60 * 60)); // 대략적인 월 계산
                    diffSeconds -= months * (30 * 24 * 60 * 60);
                    const days = Math.floor(diffSeconds / (24 * 60 * 60));
                    diffSeconds -= days * (24 * 60 * 60);
                    const hours = Math.floor(diffSeconds / (60 * 60));
                    diffSeconds -= hours * (60 * 60);
                    const minutes = Math.floor(diffSeconds / 60);
                    diffSeconds -= minutes * 60;
                    const seconds = diffSeconds;

                    let result = '';
                    if (years > 0) result += `${years}년 `;
                    if (months > 0) result += `${months}개월 `;
                    if (days > 0) result += `${days}일 `;
                    if (hours > 0) result += `${hours}시간 `;
                    if (minutes > 0) result += `${minutes}분 `;
                    if (seconds > 0) result += `${seconds}초`;
                    
                    resultText = result.trim() || '방금';
                }
            }
            processedText = processedText.replace(/{since}/g, resultText);
        }

        // {editor}
        if (commandState && 'editorValue' in commandState && commandState.editorValue !== undefined) {
            processedText = processedText.replace(/{editor}/g, commandState.editorValue || '');
        }

        // Custom internal variables (not on frontend list but useful)
        if (commandState?.totalCount !== undefined) {
            processedText = processedText.replace(/{total_count}/g, commandState.totalCount.toString());
            processedText = processedText.replace(/{countall}/g, commandState.totalCount.toString()); // Add countall
        }
        if (chat?.profile?.userIdHash && commandState?.userCounts?.[chat.profile.userIdHash] !== undefined) {
            processedText = processedText.replace(/{user_count}/g, commandState.userCounts[chat.profile.userIdHash].toString());
            processedText = processedText.replace(/{count}/g, commandState.userCounts[chat.profile.userIdHash].toString()); // Add count
        }
        if (chat?.profile?.userIdHash && processedText.includes('{points}')) {
            const userPoints = this.bot.pointManager.getPointsData()[chat.profile.userIdHash]?.points || 0;
            processedText = processedText.replace(/{points}/g, userPoints.toLocaleString());
        }
        if (processedText.includes('{song}')) {
            const currentSong = this.bot.songManager.getCurrentSong();
            processedText = processedText.replace(/{song}/g, currentSong ? currentSong.title : '현재 재생중인 노래가 없습니다.');
        }
        if (processedText.includes('{requester}')) {
            const currentSong = this.bot.songManager.getCurrentSong();
            processedText = processedText.replace(/{requester}/g, currentSong ? currentSong.requester : '신청자가 없습니다.');
        }
        if (processedText.includes('{queue}')) {
            const queue = this.bot.songManager.getQueue();
            processedText = processedText.replace(/{queue}/g, queue.length > 0 ? queue.map(s => s.title).join(', ') : '대기열이 비어있습니다.');
        }

        // {else(item1,item2,...)}
        processedText = processedText.replace(/{else\(([^)]+)\)}/g, (match, items) => {
            const options = items.split(',').map((s: string) => s.trim());
            return options[Math.floor(Math.random() * options.length)];
        });
        
        // {help} - must be last as it might contain other variables
        if (processedText.includes('{help}')) {
            const commandList = this.bot.commandManager.getCommands()
                .map(c => {
                    const triggers = c.triggers || (c.trigger ? [c.trigger] : []);
                    return triggers[0] || 'unknown';
                })
                .filter(trigger => trigger !== 'unknown')
                .join(', ');
            const helpText = `사용 가능한 명령어: ${commandList}`;
            processedText = processedText.replace(/{help}/g, helpText);
        }

        return processedText;
    }
}