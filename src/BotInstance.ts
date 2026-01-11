import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent } from 'chzzk';
import { supabase, BotSettings, Command } from './supabase';

interface BotConfig {
  userId: string;
  channelId: string;
  nidAuth?: string;
  nidSession?: string;
  settings: BotSettings;
}

export class BotInstance {
  private client: ChzzkClient;
  private chat: ChzzkChat | null = null;
  private userId: string;
  private channelId: string;
  private settings: BotSettings;

  // 명령어 캐시
  private commands: Command[] = [];
  private triggerCache: Set<string> = new Set();

  // 포인트 쿨다운
  private lastPointsTime: Map<string, number> = new Map();
  private commandCooldowns: Map<string, number> = new Map();

  // Realtime 구독
  private commandSubscription: any = null;

  constructor(config: BotConfig) {
    this.userId = config.userId;
    this.channelId = config.channelId;
    this.settings = config.settings;

    this.client = new ChzzkClient({
      nidAuth: config.nidAuth,
      nidSession: config.nidSession,
    });
  }

  async connect(): Promise<void> {
    // 명령어 로드
    await this.loadCommands();

    // Realtime으로 명령어 변경 감지
    this.subscribeToCommands();

    // 채널 라이브 상태 확인
    const liveDetail = await this.client.live.detail(this.channelId);
    if (!liveDetail?.chatChannelId) {
      throw new Error('Channel is not live or chat unavailable');
    }

    console.log(`[Bot:${this.channelId}] Connecting to chat...`);

    this.chat = this.client.chat({
      channelId: this.channelId,
      chatChannelId: liveDetail.chatChannelId,
    });

    this.setupListeners();
    await this.chat.connect();

    console.log(`[Bot:${this.channelId}] Connected!`);
  }

  async disconnect(): Promise<void> {
    if (this.commandSubscription) {
      await this.commandSubscription.unsubscribe();
      this.commandSubscription = null;
    }

    if (this.chat) {
      await this.chat.disconnect();
      this.chat = null;
    }

    console.log(`[Bot:${this.channelId}] Disconnected`);
  }

  private async loadCommands(): Promise<void> {
    const { data: commands } = await supabase
      .from('commands')
      .select('*')
      .eq('user_id', this.userId)
      .eq('enabled', true);

    this.commands = commands || [];
    this.rebuildTriggerCache();

    console.log(`[Bot:${this.channelId}] Loaded ${this.commands.length} commands`);
  }

  private rebuildTriggerCache(): void {
    this.triggerCache.clear();
    for (const cmd of this.commands) {
      for (const trigger of cmd.triggers) {
        this.triggerCache.add(trigger);
      }
    }
  }

  private subscribeToCommands(): void {
    this.commandSubscription = supabase
      .channel(`commands:${this.userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'commands',
          filter: `user_id=eq.${this.userId}`,
        },
        () => {
          console.log(`[Bot:${this.channelId}] Commands changed, reloading...`);
          this.loadCommands();
        }
      )
      .subscribe();
  }

  private setupListeners(): void {
    if (!this.chat) return;

    this.chat.on('connect', () => {
      console.log(`[Bot:${this.channelId}] Chat connected`);
    });

    this.chat.on('disconnect', () => {
      console.log(`[Bot:${this.channelId}] Chat disconnected`);
    });

    this.chat.on('chat', async (chat: ChatEvent) => {
      await this.handleChat(chat);
    });

    this.chat.on('donation', async (donation: DonationEvent) => {
      await this.handleDonation(donation);
    });
  }

  private async handleChat(chat: ChatEvent): Promise<void> {
    const msg = chat.message?.trim();
    if (!msg || chat.hidden) return;

    // 포인트 지급
    if (this.settings.points_enabled) {
      await this.awardPoints(chat);
    }

    // 명령어 체크
    const firstWord = msg.split(' ')[0];

    // 시스템 명령어
    if (firstWord.startsWith(this.settings.prefix || '!')) {
      switch (firstWord) {
        case `${this.settings.prefix}포인트`:
        case '!포인트':
          await this.handlePointsCommand(chat);
          return;
      }
    }

    // 커스텀 명령어
    if (this.triggerCache.has(firstWord)) {
      await this.executeCommand(chat, firstWord);
    } else {
      // {any} 패턴 체크
      for (const cmd of this.commands) {
        for (const trigger of cmd.triggers) {
          if (trigger.endsWith('{any}')) {
            const prefix = trigger.replace('{any}', '');
            if (msg.includes(prefix)) {
              await this.executeCommandByObj(chat, cmd);
              return;
            }
          }
        }
      }
    }
  }

  private async awardPoints(chat: ChatEvent): Promise<void> {
    const viewerId = chat.profile.userIdHash;
    const now = Date.now();
    const lastTime = this.lastPointsTime.get(viewerId) || 0;
    const interval = 30000; // 30초

    if (now - lastTime < interval) return;

    this.lastPointsTime.set(viewerId, now);

    // Supabase에 포인트 저장
    const { data: existing } = await supabase
      .from('viewer_points')
      .select('id, points')
      .eq('user_id', this.userId)
      .eq('viewer_hash', viewerId)
      .single();

    if (existing) {
      await supabase
        .from('viewer_points')
        .update({
          points: existing.points + this.settings.points_per_chat,
          viewer_nickname: chat.profile.nickname,
          last_chat_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      await supabase.from('viewer_points').insert({
        user_id: this.userId,
        viewer_hash: viewerId,
        viewer_nickname: chat.profile.nickname,
        points: this.settings.points_per_chat,
        last_chat_at: new Date().toISOString(),
      });
    }
  }

  private async handlePointsCommand(chat: ChatEvent): Promise<void> {
    const viewerId = chat.profile.userIdHash;

    const { data } = await supabase
      .from('viewer_points')
      .select('points')
      .eq('user_id', this.userId)
      .eq('viewer_hash', viewerId)
      .single();

    const points = data?.points || 0;
    const pointsName = this.settings.points_name || '포인트';

    this.chat?.sendChat(`${chat.profile.nickname}님의 ${pointsName}: ${points.toLocaleString()}`);
  }

  private async executeCommand(chat: ChatEvent, trigger: string): Promise<void> {
    const command = this.commands.find(c => c.triggers.includes(trigger));
    if (!command) return;

    await this.executeCommandByObj(chat, command);
  }

  private async executeCommandByObj(chat: ChatEvent, command: Command): Promise<void> {
    // 쿨다운 체크 (전역 5초)
    const cooldownKey = command.id;
    const now = Date.now();
    const lastUse = this.commandCooldowns.get(cooldownKey) || 0;

    if (now - lastUse < 5000) return;
    this.commandCooldowns.set(cooldownKey, now);

    // 변수 치환
    let response = command.response;
    response = response.replace(/{user}/g, chat.profile.nickname);
    response = response.replace(/{channel}/g, this.channelId);
    response = response.replace(/{count}/g, String(command.total_count + 1));

    // {editor} 처리
    if (response.includes('{editor}')) {
      const args = chat.message?.split(' ').slice(1).join(' ') || '';
      if (args) {
        // 새 값 저장
        await supabase
          .from('commands')
          .update({ editor_value: args })
          .eq('id', command.id);
        command.editor_value = args;
      }
      response = response.replace(/{editor}/g, command.editor_value || '(없음)');
    }

    // 사용 횟수 업데이트
    await supabase
      .from('commands')
      .update({ total_count: command.total_count + 1 })
      .eq('id', command.id);

    command.total_count++;

    // 응답 전송
    this.chat?.sendChat(response);
  }

  private async handleDonation(donation: DonationEvent): Promise<void> {
    const nickname = (donation as any).nickname || (donation as any).profile?.nickname || 'Unknown';
    console.log(`[Bot:${this.channelId}] Donation from ${nickname}: ${donation.message}`);

    // 노래 신청 처리 (유튜브 URL 감지)
    if (this.settings.song_request_enabled) {
      const youtubeRegex = /(?:https?:\/\/)?[^\s]*youtu(?:be\.com\/watch\?v=|\.be\/)([a-zA-Z0-9_-]{11})/;
      const match = donation.message?.match(youtubeRegex);

      if (match && match[1]) {
        await this.addSongRequest(match[1], nickname);
      }
    }
  }

  private async addSongRequest(videoId: string, requester: string): Promise<void> {
    try {
      // 간단히 YouTube oEmbed API로 제목 가져오기
      const response = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );

      if (!response.ok) {
        this.chat?.sendChat('유효하지 않은 유튜브 영상입니다.');
        return;
      }

      const data = await response.json() as { title: string };

      await supabase.from('song_queue').insert({
        user_id: this.userId,
        video_id: videoId,
        title: data.title,
        duration: 0, // oEmbed에서는 duration을 제공하지 않음
        requester_nickname: requester,
        requester_hash: 'donation',
        is_played: false,
      });

      this.chat?.sendChat(`노래가 추가되었습니다: ${data.title}`);
    } catch (err) {
      console.error(`[Bot:${this.channelId}] Failed to add song:`, err);
    }
  }

  isConnected(): boolean {
    return this.chat?.connected ?? false;
  }

  sendChat(message: string): void {
    this.chat?.sendChat(message);
  }
}
