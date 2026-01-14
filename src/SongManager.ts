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
    private onStateChangeCallback: (type: string, payload: any) => void = () => {};
    private isPlayerConnected: boolean = false;
    private userCooldowns: Map<string, number> = new Map();

    constructor(private bot: BotInstance, initialData: any) {
        this.queue = initialData.songQueue || [];
        this.currentSong = initialData.currentSong || null;
    }

    public setOnStateChangeListener(callback: (type: string, payload: any) => void) {
        this.onStateChangeCallback = callback;
    }

    private notify(type: string = 'songStateUpdate') { 
        this.onStateChangeCallback(type, this.getState());
        this.bot.saveAll(); 
    }

    public getState() { return { queue: this.queue, currentSong: this.currentSong, isPlaying: this.isPlaying }; }

    public setPlayerConnected(connected: boolean) {
        this.isPlayerConnected = connected;
        // 플레이어가 연결되면 현재 멈춰있던 곡 재생 시도 또는 다음 곡 재생
        if (connected) {
            if (!this.currentSong && this.queue.length > 0) this.playNext();
            else this.notify();
        }
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];
        const subCmd = parts[1];

        if (cmd !== '!노래') return;
        if (settings.songRequestMode === 'off') return;

        if (!subCmd || subCmd === '도움말') return chzzkChat.sendChat('🎵 [명령어] !노래 신청 [링크], !노래 스킵');

        if (subCmd === '신청') {
            const query = parts.slice(2).join(' ');
            if (!this.isValidYoutubeLink(query)) return chzzkChat.sendChat('❌ 올바른 링크를 입력하세요.');

            if (settings.songRequestMode === 'cooldown') {
                const lastTime = this.userCooldowns.get(chat.profile.userIdHash) || 0;
                const now = Date.now();
                if (now - lastTime < (settings.songRequestCooldown * 1000)) return chzzkChat.sendChat(`⏳ 쿨타임 중입니다.`);
                this.userCooldowns.set(chat.profile.userIdHash, now);
            }

            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                chzzkChat.sendChat(`✅ 추가됨: ${song.title}`);
                
                // [핵심] 플레이어 연결 여부와 상관없이, 현재 곡이 없으면 무조건 다음 곡 재생 (DB 저장 -> 플레이어 켜면 자동 재생)
                if (!this.currentSong) {
                    this.playNext();
                } else {
                    this.notify();
                }
            } catch (err) { chzzkChat.sendChat('❌ 영상 정보를 가져올 수 없습니다.'); }
        } 
        else if (subCmd === '스킵') {
            this.skipSong();
            chzzkChat.sendChat('⏭️ 스킵되었습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, message: string, settings: any) {
        if (donation.payAmount !== (settings.minDonationAmount || 0)) return;
        const urlMatch = message.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch && this.isValidYoutubeLink(urlMatch[0])) {
            try {
                const song = await this.fetchSongInfo(urlMatch[0], donation.profile.nickname);
                this.queue.push(song);
                if (this.bot.chat) this.bot.chat.sendChat(`💰 후원 곡 추가: ${song.title}`);
                if (!this.currentSong) this.playNext();
                else this.notify();
            } catch (err) {}
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
        } catch (e) {}

        const info = await ytdl.getBasicInfo(videoId);
        return {
            videoId: info.videoDetails.videoId,
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[0]?.url,
            requester,
            requestedAt: Date.now()
        };
    }

    public playNext() {
        if (this.queue.length > 0) {
            this.currentSong = this.queue.shift() || null;
            this.isPlaying = true;
            this.notify();
            // [중요] 플레이어에게 명시적 재생 명령 전송
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

    public togglePlayPause() {
        this.isPlaying = !this.isPlaying;
        this.onStateChangeCallback('playerControl', { action: this.isPlaying ? 'play' : 'pause' });
        this.notify();
    }

    public getData() { 
        return { 
            songQueue: this.queue, 
            currentSong: this.currentSong,
            isPlaying: this.isPlaying
        }; 
    }
}