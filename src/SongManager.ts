import { ChatEvent, ChzzkChat, DonationEvent } from 'chzzk';
import ytdl from '@distube/ytdl-core';
import { BotInstance } from './BotInstance';

export interface Song {
    videoId: string;
    title: string;
    thumbnail: string;
    requester: string;
    requestedAt: number;
}

export class SongManager {
    private queue: Song[] = [];
    private currentSong: Song | null = null;
    private onStateChangeCallback: () => void = () => {};
    private isPlayerConnected: boolean = false;
    private userCooldowns: Map<string, number> = new Map();

    constructor(private bot: BotInstance, initialData: any) {
        this.queue = initialData.songQueue || [];
        this.currentSong = initialData.currentSong || null;
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() { 
        this.onStateChangeCallback();
        this.bot.saveAll(); 
    }

    public getState() { return { queue: this.queue, currentSong: this.currentSong }; }

    public setPlayerConnected(connected: boolean) {
        this.isPlayerConnected = connected;
        if (connected && !this.currentSong && this.queue.length > 0) this.playNext();
        else if (connected && this.currentSong) this.notify();
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];
        const subCmd = parts[1];

        if (cmd !== '!노래') return;

        if (settings.songRequestMode === 'off') return;

        if (!subCmd || subCmd === '도움말') {
            return chzzkChat.sendChat('🎵 [도움말] !노래 신청 [링크], !노래 스킵, !노래 대기열');
        }

        if (subCmd === '신청') {
            if (settings.songRequestMode === 'donation') {
                return chzzkChat.sendChat(`💸 현재 ${settings.minDonationAmount}치즈 후원으로만 신청 가능합니다.`);
            }

            const query = parts.slice(2).join(' ');
            // [수정] 채팅 신청 시에도 링크 검증 강화
            if (!this.isValidYoutubeLink(query)) {
                return chzzkChat.sendChat('❌ 올바른 유튜브 링크를 포함해주세요.');
            }

            if (settings.songRequestMode === 'cooldown') {
                const lastTime = this.userCooldowns.get(chat.profile.userIdHash) || 0;
                const now = Date.now();
                const cooldownMs = (settings.songRequestCooldown || 30) * 1000;
                if (now - lastTime < cooldownMs) {
                    const remaining = Math.ceil((cooldownMs - (now - lastTime)) / 1000);
                    return chzzkChat.sendChat(`⏳ 쿨타임! ${remaining}초 뒤에 가능합니다.`);
                }
                this.userCooldowns.set(chat.profile.userIdHash, now);
            }
            
            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                this.notify();
                chzzkChat.sendChat(`✅ 대기열 추가: ${song.title}`);
                if (this.isPlayerConnected && !this.currentSong && this.queue.length === 1) this.playNext();
            } catch (err) { chzzkChat.sendChat('❌ 영상 정보를 가져올 수 없습니다.'); }
        } 
        // ... (나머지 스킵, 대기열 로직 동일)
        else if (subCmd === '스킵') {
            const role = chat.profile.userRoleCode;
            if (role === 'streamer' || role === 'manager' || chat.profile.badge?.imageUrl?.includes('manager')) {
                this.skipSong();
                chzzkChat.sendChat('⏭️ 스킵되었습니다.');
            } else { chzzkChat.sendChat('🛡️ 권한이 없습니다.'); }
        } 
        else if (subCmd === '대기열') {
            if (this.queue.length === 0) return chzzkChat.sendChat('📜 대기열 없음');
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(`📜 대기열: ${list}...`);
        }
    }

    // [중요] 링크 유효성 체크 도우미
    private isValidYoutubeLink(text: string): boolean {
        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        return youtubeRegex.test(text);
    }

    /**
     * [최종 수정] 후원 메시지 정밀 처리
     */
    public async addSongFromDonation(donation: DonationEvent, message: string, settings: any) {
        if (settings.songRequestMode === 'off') return;

        // [핵심] 정확히 설정한 금액일 때만 작동 (Exact Match)
        if (donation.payAmount !== (settings.minDonationAmount || 0)) {
            console.log(`[Song] Donation amount mismatch: expected ${settings.minDonationAmount}, got ${donation.payAmount}`);
            return;
        }

        // [핵심] 링크 추출
        const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = message.match(youtubeRegex);

        // 링크가 없으면 단호하게 무시
        if (!match || !match[1]) {
            console.log('[Song] No valid link found in donation message. Ignoring.');
            return;
        }

        try {
            const song = await this.fetchSongInfo(match[1], donation.profile.nickname);
            this.queue.push(song);
            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`💰 후원 신청곡이 수락되었습니다: ${song.title}`);
            if (this.isPlayerConnected && !this.currentSong && this.queue.length === 1) this.playNext();
        } catch (err) {
            console.error('[Song] Donation fetch failed:', err);
        }
    }

    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        let videoId = query;
        if (query.includes('youtu')) {
            try { videoId = ytdl.getURLVideoID(query); } catch { throw new Error('Invalid URL'); }
        }
        try {
            const info = await ytdl.getBasicInfo(videoId);
            return {
                videoId,
                title: info.videoDetails.title,
                thumbnail: info.videoDetails.thumbnails[0]?.url,
                requester,
                requestedAt: Date.now()
            };
        } catch (err) { throw new Error('Info Error'); }
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.notify();
        } else {
            this.currentSong = null;
            this.notify();
        }
    }

    public skipSong() { this.playNext(); }

    public removeSong(index: number) {
        if (index >= 0 && index < this.queue.length) {
            this.queue.splice(index, 1);
            this.notify();
        }
    }

    public togglePlayPause() { this.notify(); }
    public getData() { return { songQueue: this.queue, currentSong: this.currentSong }; }
}