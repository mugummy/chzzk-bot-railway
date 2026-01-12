// src/SongManager.ts

import ytdl from "@distube/ytdl-core";
import { google } from "googleapis";
import { DataManager, BotData } from "./DataManager";
import { ChatBot } from "./Bot";
import { ChatEvent } from "chzzk";
import { BotSettings } from "./SettingsManager";

const youtube = google.youtube("v3");
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

export interface Song {
  id: string;
  title: string;
  url: string;
  requester: string;
  thumbnail?: string; // 썸네일을 선택적으로 변경
}

export class SongManager {
  private queue: Song[] = [];
  private currentSong: Song | null = null;
  private isPlaying: boolean = false;
  private onStateChangeCallback: (() => void) | null = null;

  constructor(private bot: ChatBot, loadedData?: Partial<BotData>) {
    // [추가] 데이터 로드 로직
    this.queue = loadedData?.songQueue || [];
    this.currentSong = loadedData?.currentSong || null;
    this.isPlaying = false; // 봇 시작 시 isPlaying을 false로 초기화
  }

  public setOnStateChangeListener(callback: () => void) {
    this.onStateChangeCallback = callback;
  }

  private notifyStateChange() {
    console.log(`[SongManager] ========== STATE CHANGE ==========`);
    console.log(`[SongManager] Current Song: ${this.currentSong ? this.currentSong.title : 'None'}`);
    console.log(`[SongManager] Is Playing: ${this.isPlaying}`);
    console.log(`[SongManager] Queue Length: ${this.queue.length}`);
    console.log(`[SongManager] Queue: [${this.queue.map(s => s.title).join(', ')}]`);
    
    if (this.onStateChangeCallback) {
      console.log(`[SongManager] Calling state change callback...`);
      this.onStateChangeCallback();
    } else {
      console.log(`[SongManager] No state change callback set!`);
    }
    
    console.log(`[SongManager] Saving all data...`);
    this.bot.saveAllData();
    console.log(`[SongManager] ========== STATE CHANGE END ==========`);
  }
  
  // [추가] 데이터 저장을 위한 데이터 반환 함수
  public getData() {
    return {
        songQueue: this.queue, // 실제 대기열 저장
        currentSong: this.currentSong // 실제 현재 노래 저장
    };
  }

  // [추가] main.ts에서 호출하는 모든 함수를 구현합니다.
  public getState() {
    return {
      queue: this.queue,
      currentSong: this.currentSong,
      isPlaying: this.isPlaying,
    };
  }

  public playSong(query: string): void {
    this.requestSong(query, "Web UI");
  }

  public skipSong(): void {
    this.playNextSong();
  }
  
  public togglePlayPause(): void {
    if (this.currentSong) {
      this.isPlaying = !this.isPlaying;
      this.notifyStateChange();
    }
  }

  public removeCurrentSong(): void {
    this.playNextSong();
  }
  
  public removeFromQueue(songId: string): void {
    const songIndex = this.queue.findIndex(song => song.id === songId);
    if (songIndex > -1) {
      this.queue.splice(songIndex, 1);
      this.notifyStateChange();
    }
  }

  public playFromQueue(songId: string): void {
    const songIndex = this.queue.findIndex(song => song.id === songId);
    if (songIndex > -1) {
      const song = this.queue.splice(songIndex, 1)[0];
      this.currentSong = song;
      this.isPlaying = true;
      this.notifyStateChange();
    }
  }

  async requestSong(query: string, requester: string): Promise<Song> {
    if (!YOUTUBE_API_KEY) {
      throw new Error("유튜브 API 키가 설정되지 않았습니다. .env 파일 확인이 필요합니다.");
    }
    
    // 입력값 검증 및 정리
    const sanitizedQuery = query.trim();
    if (!sanitizedQuery) {
      throw new Error("검색어 또는 URL을 입력해주세요.");
    }
    
    let videoId = "";
    let videoTitle = "";
    let thumbnailUrl: string | undefined;

    if (ytdl.validateURL(sanitizedQuery) || ytdl.validateID(sanitizedQuery)) {
      const info = await ytdl.getInfo(sanitizedQuery);
      videoId = info.videoDetails.videoId;
      videoTitle = info.videoDetails.title;
      if (info.videoDetails.thumbnails && info.videoDetails.thumbnails.length > 0) {
        thumbnailUrl = info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url;
      }
    } else {
      const searchResult = await youtube.search.list({
        key: YOUTUBE_API_KEY,
        part: ["snippet"],
        q: query,
        type: ["video"],
        maxResults: 1,
      });

      if (
        !searchResult.data.items ||
        searchResult.data.items.length === 0 ||
        !searchResult.data.items[0].id?.videoId ||
        !searchResult.data.items[0].snippet?.title
      ) {
        throw new Error("검색 결과가 없습니다.");
      }
      videoId = searchResult.data.items[0].id.videoId;
      videoTitle = searchResult.data.items[0].snippet.title;
      thumbnailUrl = searchResult.data.items[0].snippet?.thumbnails?.high?.url ?? undefined;
    }

    const song: Song = {
      id: videoId,
      title: videoTitle,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      requester,
      thumbnail: thumbnailUrl,
    };

    if (!this.currentSong && this.queue.length === 0) {
      this.currentSong = song;
      this.isPlaying = true;
      this.notifyStateChange();
    } else {
      this.queue.push(song);
      this.notifyStateChange();
    }

    return song;
  }

  public playNextSong(): void {
    if (this.queue.length > 0) {
      this.currentSong = this.queue.shift()!;
      this.isPlaying = true;
    } else {
      this.currentSong = null;
      this.isPlaying = false;
    }
    this.notifyStateChange();
  }

  getQueue(): Song[] {
    return this.queue;
  }

  getCurrentSong(): Song | null {
    return this.currentSong;
  }

  public async handleCommand(chat: ChatEvent, chatClient: any, settings: BotSettings) {
    console.log(`[SongManager] handleCommand called for message: ${chat.message}`);
    const message = chat.message.trim();
    const args = message.split(' ').slice(1);
    const command = message.split(' ')[0];
    const requester = chat.profile.nickname;

    try {
        if (command === '!노래신청' || command === '!노래') {
            // 신청곡 모드 확인
            if (settings.songRequestMode === 'off') {
                chatClient.sendChat('현재 신청곡 기능이 비활성화되어 있습니다.');
                return;
            }
            
            if (args.length === 0) {
                chatClient.sendChat('사용법: !노래신청 <노래 제목 또는 유튜브 URL>');
                return;
            }
            
            // 쿨다운 확인 (songRequestMode가 'cooldown'인 경우)
            if (settings.songRequestMode === 'cooldown') {
                // 쿨다운 로직은 나중에 구현할 수 있습니다
                console.log(`[SongManager] Cooldown mode - allowing request for now`);
            }
            
            const query = args.join(' ');
            const song = await this.requestSong(query, requester);
            chatClient.sendChat(`[${song.title}]이(가) 신청되었습니다. (신청자: ${song.requester}) 대기열: ${this.getQueue().length}번째`);
        } else if (command === '!대기열' || command === '!신청곡목록') {
            const queue = this.getQueue();
            if (queue.length === 0) {
                chatClient.sendChat('신청곡 목록이 비어있습니다.');
                return;
            }
            const songList = queue.map((song, index) => `${index + 1}. ${song.title}`).join(', ');
            chatClient.sendChat(`신청곡 목록: ${songList}`);
        } else if (command === '!현재노래') {
            const currentSong = this.getCurrentSong();
            if (currentSong) {
                chatClient.sendChat(`현재 재생 중: ${currentSong.title} (신청자: ${currentSong.requester})`);
            } else {
                chatClient.sendChat('현재 재생 중인 노래가 없습니다.');
            }
        } else if (command === '!다음곡' || command === '!스킵') {
            const currentRequester = this.getCurrentSong()?.requester;
            // [수정] 가장 안정적인 권한 확인 방식으로 수정합니다.
            const privileges = (chat.profile as any).privileges || [];
            const isManager = privileges.includes('channel_manager');
            const isStreamer = privileges.includes('streamer');

            if (isManager || isStreamer || requester === currentRequester) {
                this.playNextSong();
                const nextSong = this.getCurrentSong();
                if (nextSong) {
                    chatClient.sendChat(`다음 곡을 재생합니다: ${nextSong.title}`);
                } else {
                    chatClient.sendChat('대기열에 다음 곡이 없습니다. 노래 재생을 종료합니다.');
                }
            } else {
                chatClient.sendChat('스트리머, 관리자 또는 노래를 신청한 사람만 다음 곡으로 넘길 수 있습니다.');
            }
        }
    } catch (error: any) {
        console.error("Song command error:", error);
        chatClient.sendChat(`오류가 발생했습니다: ${error.message}`);
    }
  }

  public async addSongFromDonation(donation: any, url: string, settings: BotSettings): Promise<Song> {
      console.log("Donation song request received:", url);
      const song = await this.requestSong(url, donation.profile.nickname);
      return song;
  }

  // 설정 업데이트 메서드
  public updateSetting(setting: string, value: any): void {
      console.log(`Updating song setting: ${setting} = ${value}`);
      
      // 실제 봇 설정을 업데이트
      const settingsUpdate: any = {};
      
      switch (setting) {
          case 'songRequestMode':
              settingsUpdate.songRequestMode = value;
              console.log(`Song request mode changed to: ${value}`);
              break;
          case 'playbackMode':
              settingsUpdate.playbackMode = value;
              console.log(`Playback mode changed to: ${value}`);
              break;
          case 'songRequestCooldown':
              settingsUpdate.songRequestCooldown = parseInt(value) || 30;
              console.log(`Song request cooldown changed to: ${settingsUpdate.songRequestCooldown} seconds`);
              break;
          case 'songRequestMinDonation':
              settingsUpdate.songRequestMinDonation = parseInt(value) || 1000;
              console.log(`Donation request minimum amount changed to: ${settingsUpdate.songRequestMinDonation} won`);
              break;
          default:
              console.warn(`Unknown song setting: ${setting}`);
              return;
      }
      
      // 봇 설정 업데이트 및 저장
      this.bot.updateSettings(settingsUpdate);
      
      // 상태 변경 알림
      this.notifyStateChange();
  }
}