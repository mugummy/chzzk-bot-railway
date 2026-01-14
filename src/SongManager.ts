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
        if (connected && !this.currentSong && this.queue.length > 0) this.playNext();
        else if (connected && this.currentSong) this.notify();
    }

    public async handleCommand(chat: ChatEvent, chzzkChat: ChzzkChat, settings: any) {
        const msg = chat.message.trim();
        const parts = msg.split(' ');
        const cmd = parts[0];
        const subCmd = parts[1];

        if (cmd !== '!노래') return;
        if (settings.songRequestMode === 'off') return; // 조용히 무시 (채팅 공해 방지)

        if (!subCmd || subCmd === '도움말') {
            return chzzkChat.sendChat('🎵 [명령어] !노래 신청 [링크], !노래 스킵, !노래 대기열');
        }

        if (subCmd === '신청') {
            if (settings.songRequestMode === 'donation') return chzzkChat.sendChat(`💸 후원(${settings.minDonationAmount}치즈)으로만 신청 가능합니다.`);
            
            const query = parts.slice(2).join(' ');
            // [수정] 링크 형식 체크 완화 (youtube 도메인만 있으면 일단 시도)
            if (!query.includes('youtu')) return chzzkChat.sendChat('❌ 유튜브 링크를 입력해주세요.');

            if (settings.songRequestMode === 'cooldown') {
                const lastTime = this.userCooldowns.get(chat.profile.userIdHash) || 0;
                const now = Date.now();
                const cooldownMs = (settings.songRequestCooldown || 30) * 1000;
                if (now - lastTime < cooldownMs) {
                    const remaining = Math.ceil((cooldownMs - (now - lastTime)) / 1000);
                    return chzzkChat.sendChat(`⏳ ${remaining}초 뒤에 가능합니다.`);
                }
                this.userCooldowns.set(chat.profile.userIdHash, now);
            }

            try {
                const song = await this.fetchSongInfo(query, chat.profile.nickname);
                this.queue.push(song);
                chzzkChat.sendChat(`✅ 추가됨: ${song.title}`);
                if (this.isPlayerConnected && !this.currentSong && this.queue.length === 1) this.playNext();
                else this.notify();
            } catch (err) { chzzkChat.sendChat('❌ 영상을 찾을 수 없습니다.'); }
        } 
        else if (subCmd === '스킵') {
            const role = chat.profile.userRoleCode;
            if (role === 'streamer' || role === 'manager' || chat.profile.badge?.imageUrl?.includes('manager')) {
                this.skipSong();
                chzzkChat.sendChat('⏭️ 스킵되었습니다.');
            } else { chzzkChat.sendChat('🛡️ 권한이 없습니다.'); }
        }
        else if (subCmd === '대기열') {
            const list = this.queue.slice(0, 3).map((s, i) => `${i+1}. ${s.title}`).join(' / ');
            chzzkChat.sendChat(list ? `📜 대기열: ${list}...` : '📜 대기열이 비어있습니다.');
        }
    }

    public async addSongFromDonation(donation: DonationEvent, message: string, settings: any) {
        if (donation.payAmount !== (settings.minDonationAmount || 0)) return;
        
        // 후원 메시지 내 링크 추출 (가장 먼저 발견된 URL 하나만 처리)
        const urlMatch = message.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch && urlMatch[0].includes('youtu')) {
            try {
                const song = await this.fetchSongInfo(urlMatch[0], donation.profile.nickname);
                this.queue.push(song);
                if (this.bot.chat) this.bot.chat.sendChat(`💰 후원 곡 추가: ${song.title}`);
                if (!this.currentSong) this.playNext();
                else this.notify();
            } catch (err) {}
        }
    }

    // [핵심] 단일 영상 ID 추출 로직 (믹스/재생목록 무시)
    private async fetchSongInfo(query: string, requester: string): Promise<Song> {
        let videoId = query;
        
        try {
            // URL 파싱 시도
            if (query.includes('://')) {
                const url = new URL(query);
                // 1. v 파라미터가 최우선 (watch?v=ID)
                if (url.searchParams.has('v')) {
                    videoId = url.searchParams.get('v')!;
                } 
                // 2. Shorts 경로 처리
                else if (url.pathname.includes('/shorts/')) {
                    videoId = url.pathname.split('/shorts/')[1];
                } 
                // 3. youtu.be 단축 URL 처리
                else if (url.hostname === 'youtu.be') {
                    videoId = url.pathname.slice(1);
                }
            }
        } catch (e) {
            // URL 파싱 실패 시 정규식이나 원본 문자열 사용
        }

        // ID만 남기고 나머지(재생목록 list 등)는 버려짐 -> 단일 영상 정보 획득
        const info = await ytdl.getBasicInfo(videoId);
        
        return {
            videoId: info.videoDetails.videoId, // ytdl이 정규화한 ID 사용
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
}