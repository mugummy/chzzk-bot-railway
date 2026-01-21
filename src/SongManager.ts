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
    private isPlaying: boolean = false;
    private onStateChangeCallback: (type: string, payload: any) => void = () => { };
    private isPlayerConnected: boolean = false;
    private userCooldowns: Map<string, number> = new Map();

    constructor(private bot: BotInstance, initialData: any) {
        this.queue = initialData.songQueue || [];
        this.currentSong = initialData.currentSong || null;
        // DB에 저장된 상태가 있다면 복구, 없으면 false
        this.isPlaying = false;
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify(type: string = 'songStateUpdate', payload: any = this.getState()) {
        this.onStateChangeCallback(type, payload);
        this.bot.saveAll();
    }

    public getState() { return { queue: this.queue, currentSong: this.currentSong, isPlaying: this.isPlaying }; }

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

        if (!subCmd || subCmd === '도움말') {
            let statusText = '🟢 전체 허용';
            if (settings.songRequestMode === 'off') statusText = '🔴 기능 꺼짐';
            else if (settings.songRequestMode === 'donation') statusText = `💸 후원 전용 (${settings.minDonationAmount}치즈)`;
            else if (settings.songRequestMode === 'cooldown') statusText = `⏳ 쿨타임 (${settings.songRequestCooldown}초)`;

            return chzzkChat.sendChat(`🎵 [${statusText}] !노래 신청 [링크], !노래 스킵, !노래 대기열`);
        }

        if (settings.songRequestMode === 'off') {
            return chzzkChat.sendChat('⛔ 신청곡 기능이 비활성화되어 있습니다.');
        }

        if (subCmd === '신청') {
            if (settings.songRequestMode === 'donation') {
                return chzzkChat.sendChat(`💸 후원(${settings.minDonationAmount}치즈)으로만 신청 가능합니다.`);
            }

            const query = parts.slice(2).join(' ');
            if (!this.isValidYoutubeLink(query)) return chzzkChat.sendChat('❌ 올바른 유튜브 링크를 입력하세요.');

            if (settings.songRequestMode === 'cooldown') {
                const lastTime = this.userCooldowns.get(chat.profile.userIdHash) || 0;
                const now = Date.now();
                const cooldownMs = (settings.songRequestCooldown || 30) * 1000;
                if (now - lastTime < cooldownMs) {
                    const remaining = Math.ceil((cooldownMs - (now - lastTime)) / 1000);
                    return chzzkChat.sendChat(`⏳ 쿨타임! ${remaining}초 뒤에 다시 신청해주세요.`);
                }
                this.userCooldowns.set(chat.profile.userIdHash, now);
            }

            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                chzzkChat.sendChat(`✅ 대기열 추가: ${song.title}`);
                if (!this.currentSong) this.playNext();
                else this.notify();
            } catch (err) { chzzkChat.sendChat('❌ 영상 정보를 가져올 수 없습니다.'); }
        }
        else if (subCmd === '스킵') {
            const role = chat.profile.userRoleCode;
            if (role === 'streamer' || role === 'manager' || chat.profile.badge?.imageUrl?.includes('manager')) {
                this.skipSong();
                chzzkChat.sendChat('⏭️ 스킵되었습니다.');
            } else {
                chzzkChat.sendChat('🛡️ 스킵 권한이 없습니다.');
            }
        }
        else if (subCmd === '대기열') {
            const list = this.queue.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(list ? `📜 대기열: ${list}...` : '📜 대기열이 비어있습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, message: string, settings: any) {
        if (settings.songRequestMode === 'off') return;
        const amount = (donation as any).payAmount || donation.extras?.payAmount || 0;
        if (amount !== (settings.minDonationAmount || 0)) return;

        const urlMatch = message.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch && this.isValidYoutubeLink(urlMatch[0])) {
            try {
                const song = await this.fetchSongInfo(urlMatch[0], donation.profile.nickname);
                this.queue.push(song);
                if (this.bot.chat) this.bot.chat.sendChat(`💰 후원 곡 추가: ${song.title}`);
                if (!this.currentSong) this.playNext();
                else this.notify();
            } catch (err) { }
        }
    }

    private isValidYoutubeLink(text: string): boolean {
        return /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/.test(text);
    }

    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        let videoId = query;
        try {
            if (query.includes('://')) {
                const url = new URL(query);
                if (url.searchParams.has('v')) videoId = url.searchParams.get('v')!;
                else if (url.pathname.includes('/shorts/')) videoId = url.pathname.split('/shorts/')[1];
                else if (url.hostname === 'youtu.be') videoId = url.pathname.slice(1);
            }
        } catch (e) { }
        const info = await ytdl.getBasicInfo(videoId);
        return { videoId: info.videoDetails.videoId, title: info.videoDetails.title, thumbnail: info.videoDetails.thumbnails[0]?.url, requester, requestedAt: Date.now() };
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.isPlaying = true;
            this.notify();
            // [중요] 플레이어 재생 명령 명시적 전송
            this.onStateChangeCallback('playerControl', { action: 'play' });
        } else {
            this.currentSong = null;
            this.isPlaying = false;
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

    // [핵심] 재생/일시정지 토글 시 플레이어 제어 신호 발송
    public togglePlayPause() {
        this.isPlaying = !this.isPlaying;

        // 1. 상태 업데이트 (아이콘 변경용)
        this.notify();

        // 2. 플레이어 제어 신호 (실제 유튜브 제어용)
        this.onStateChangeCallback('playerControl', { action: this.isPlaying ? 'play' : 'pause' });

        console.log(`[SongManager] Toggled Playback: ${this.isPlaying ? 'Playing' : 'Paused'}`);
    }

    public getData() { return { songQueue: this.queue, currentSong: this.currentSong, isPlaying: this.isPlaying }; }
}