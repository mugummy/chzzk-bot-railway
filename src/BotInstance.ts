import { ChzzkClient, ChzzkChat, ChatEvent, DonationEvent } from 'chzzk';
import { supabase, BotSettings, Command, Counter } from './supabase';
import { v4 as uuidv4 } from 'uuid';

interface BotConfig {
  userId: string;
  channelId: string;
  settings: BotSettings;
}

interface VoteSession {
  id: string;
  question: string;
  options: { id: string; text: string }[];
  results: { [optionId: string]: number };
  isActive: boolean;
  durationSeconds: number;
  startTime: number | null;
  voters: Set<string>;
  voterChoices: { userIdHash: string; optionId: string; nickname: string }[];
  timer: NodeJS.Timeout | null;
}

interface DrawSession {
  id: string;
  isActive: boolean;
  isCollecting: boolean;
  keyword: string;
  participants: { userIdHash: string; nickname: string; joinedAt: number }[];
  winners: { userIdHash: string; nickname: string }[];
  settings: {
    subscriberOnly: boolean;
    excludePreviousWinners: boolean;
    maxParticipants: number;
    winnerCount: number;
  };
}

interface RouletteItem {
  id: string;
  text: string;
  weight: number;
  color: string;
}

const DEFAULT_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1'
];

export class BotInstance {
  private client: ChzzkClient;
  private chat: ChzzkChat | null = null;
  private userId: string;
  private channelId: string;
  private settings: BotSettings;

  // 명령어 캐시
  private commands: Command[] = [];
  private counters: Counter[] = [];
  private triggerCache: Set<string> = new Set();
  private counterTriggerCache: Set<string> = new Set();

  // 포인트 쿨다운
  private lastPointsTime: Map<string, number> = new Map();
  private commandCooldowns: Map<string, number> = new Map();

  // 투표/추첨/룰렛 세션
  private currentVote: VoteSession | null = null;
  private currentDraw: DrawSession | null = null;
  private rouletteItems: RouletteItem[] = [];
  private previousDrawWinners: Set<string> = new Set();

  // Realtime 구독
  private commandSubscription: any = null;
  private settingsSubscription: any = null;

  // 상태 변경 콜백
  private onStateChange: ((type: string, data: any) => void) | null = null;

  constructor(config: BotConfig) {
    this.userId = config.userId;
    this.channelId = config.channelId;
    this.settings = config.settings;

    this.client = new ChzzkClient();
  }

  setOnStateChangeListener(callback: (type: string, data: any) => void) {
    this.onStateChange = callback;
  }

  private notifyStateChange(type: string, data: any) {
    if (this.onStateChange) {
      this.onStateChange(type, data);
    }
  }

  async connect(): Promise<void> {
    // 명령어 로드
    await this.loadCommands();
    await this.loadCounters();

    // Realtime으로 변경 감지
    this.subscribeToChanges();

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

    if (this.settingsSubscription) {
      await this.settingsSubscription.unsubscribe();
      this.settingsSubscription = null;
    }

    if (this.currentVote?.timer) {
      clearTimeout(this.currentVote.timer);
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

  private async loadCounters(): Promise<void> {
    const { data: counters } = await supabase
      .from('counters')
      .select('*')
      .eq('user_id', this.userId)
      .eq('enabled', true);

    this.counters = counters || [];
    this.rebuildCounterTriggerCache();

    console.log(`[Bot:${this.channelId}] Loaded ${this.counters.length} counters`);
  }

  private rebuildTriggerCache(): void {
    this.triggerCache.clear();
    for (const cmd of this.commands) {
      for (const trigger of cmd.triggers) {
        this.triggerCache.add(trigger);
      }
    }
  }

  private rebuildCounterTriggerCache(): void {
    this.counterTriggerCache.clear();
    for (const counter of this.counters) {
      this.counterTriggerCache.add(counter.trigger);
    }
  }

  private subscribeToChanges(): void {
    // 명령어 변경 구독
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

    // 설정 변경 구독
    this.settingsSubscription = supabase
      .channel(`settings:${this.userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'bot_settings',
          filter: `user_id=eq.${this.userId}`,
        },
        async () => {
          console.log(`[Bot:${this.channelId}] Settings changed, reloading...`);
          const { data } = await supabase
            .from('bot_settings')
            .select('*')
            .eq('user_id', this.userId)
            .single();
          if (data) {
            this.settings = data;
          }
        }
      )
      .subscribe();
  }

  private setupListeners(): void {
    if (!this.chat) return;

    this.chat.on('connect', () => {
      console.log(`[Bot:${this.channelId}] Chat connected`);
      this.notifyStateChange('botStatus', { connected: true });
    });

    this.chat.on('disconnect', () => {
      console.log(`[Bot:${this.channelId}] Chat disconnected`);
      this.notifyStateChange('botStatus', { connected: false });
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

    // 채팅 알림
    this.notifyStateChange('newChat', chat);

    // 포인트 지급
    if (this.settings.points_enabled) {
      await this.awardPoints(chat);
    }

    // 추첨 참여 체크
    if (this.currentDraw?.isCollecting && msg === this.currentDraw.keyword) {
      this.addDrawParticipant(chat);
      return;
    }

    // 투표 체크
    if (this.currentVote?.isActive && msg.startsWith('!투표 ')) {
      this.handleVoteCommand(chat);
      return;
    }

    // 시스템 명령어
    const firstWord = msg.split(' ')[0];
    const prefix = this.settings.prefix || '!';

    if (firstWord.startsWith(prefix)) {
      switch (firstWord) {
        case `${prefix}포인트`:
        case '!포인트':
          await this.handlePointsCommand(chat);
          return;
        case `${prefix}투표`:
        case '!투표':
          await this.handleVoteCommand(chat);
          return;
      }
    }

    // 커스텀 명령어
    if (this.triggerCache.has(firstWord) || this.triggerCache.has(msg)) {
      await this.executeCommand(chat, firstWord);
    }

    // 카운터 체크
    if (this.counterTriggerCache.has(msg)) {
      await this.executeCounter(chat, msg);
    }
  }

  private async awardPoints(chat: ChatEvent): Promise<void> {
    const viewerId = chat.profile.userIdHash;
    const now = Date.now();
    const lastTime = this.lastPointsTime.get(viewerId) || 0;
    const cooldownMs = (this.settings.points_cooldown || 60) * 1000;

    if (now - lastTime < cooldownMs) return;

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

    // 포인트 업데이트 알림
    this.notifyStateChange('pointsUpdate', { viewerId, nickname: chat.profile.nickname });
  }

  private async handlePointsCommand(chat: ChatEvent): Promise<void> {
    const message = chat.message.trim();
    const unit = this.settings.points_name || '포인트';

    if (message === '!포인트' || message === `${this.settings.prefix}포인트`) {
      this.chat?.sendChat(`포인트 명령어: !포인트 확인 (내 포인트), !포인트 랭킹 (TOP 5)`);
    } else if (message.includes('확인')) {
      const { data } = await supabase
        .from('viewer_points')
        .select('points')
        .eq('user_id', this.userId)
        .eq('viewer_hash', chat.profile.userIdHash)
        .single();

      const points = data?.points || 0;
      this.chat?.sendChat(`${chat.profile.nickname}님의 현재 ${unit}: ${points.toLocaleString()}`);
    } else if (message.includes('랭킹')) {
      const { data } = await supabase
        .from('viewer_points')
        .select('viewer_nickname, points')
        .eq('user_id', this.userId)
        .order('points', { ascending: false })
        .limit(5);

      if (!data || data.length === 0) {
        this.chat?.sendChat(`🏆 ${unit} 랭킹 - 아직 데이터가 없습니다.`);
        return;
      }

      const ranking = data.map((u, i) => `${i + 1}위: ${u.viewer_nickname} (${u.points.toLocaleString()}${unit})`).join(' | ');
      this.chat?.sendChat(`🏆 ${unit} 랭킹 TOP 5: ${ranking}`);
    }
  }

  private async handleVoteCommand(chat: ChatEvent): Promise<void> {
    if (!this.currentVote?.isActive) return;

    const message = chat.message.trim();
    const match = message.match(/!투표\s+(\d+)/);

    if (!match) return;

    const optionNum = parseInt(match[1]);
    const option = this.currentVote.options.find(o => o.id === String(optionNum));

    if (!option) {
      return;
    }

    if (this.currentVote.voters.has(chat.profile.userIdHash)) {
      return;
    }

    this.currentVote.voters.add(chat.profile.userIdHash);
    this.currentVote.results[option.id] = (this.currentVote.results[option.id] || 0) + 1;
    this.currentVote.voterChoices.push({
      userIdHash: chat.profile.userIdHash,
      optionId: option.id,
      nickname: chat.profile.nickname,
    });

    this.notifyStateChange('voteUpdate', this.getVoteState());
  }

  private async executeCommand(chat: ChatEvent, trigger: string): Promise<void> {
    const command = this.commands.find(c => c.triggers.includes(trigger) || c.triggers.includes(chat.message.trim()));
    if (!command) return;

    // 쿨다운 체크 (5초)
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

  private async executeCounter(chat: ChatEvent, trigger: string): Promise<void> {
    const counter = this.counters.find(c => c.trigger === trigger);
    if (!counter) return;

    // 쿨다운 체크
    const cooldownKey = `counter_${counter.id}`;
    const now = Date.now();
    const lastUse = this.commandCooldowns.get(cooldownKey) || 0;

    if (now - lastUse < 5000) return;
    this.commandCooldowns.set(cooldownKey, now);

    // 카운트 증가
    const newCount = counter.count + 1;
    await supabase
      .from('counters')
      .update({ count: newCount })
      .eq('id', counter.id);

    counter.count = newCount;

    // 응답 전송
    let response = counter.response;
    response = response.replace(/{count}/g, String(newCount));
    response = response.replace(/{user}/g, chat.profile.nickname);

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
        duration: 0,
        requester_nickname: requester,
        requester_hash: 'donation',
        is_played: false,
        is_current: false,
      });

      this.chat?.sendChat(`🎵 노래가 추가되었습니다: ${data.title}`);
      this.notifyStateChange('songUpdate', { videoId, title: data.title, requester });
    } catch (err) {
      console.error(`[Bot:${this.channelId}] Failed to add song:`, err);
    }
  }

  // ========== 투표 관리 ==========
  createVote(question: string, options: string[], durationSeconds: number): { success: boolean; message?: string } {
    if (this.currentVote?.isActive) {
      return { success: false, message: '이미 진행 중인 투표가 있습니다.' };
    }

    this.currentVote = {
      id: uuidv4(),
      question,
      options: options.map((text, i) => ({ id: String(i + 1), text })),
      results: {},
      isActive: false,
      durationSeconds,
      startTime: null,
      voters: new Set(),
      voterChoices: [],
      timer: null,
    };

    this.notifyStateChange('voteUpdate', this.getVoteState());
    return { success: true };
  }

  startVote(): { success: boolean; message?: string } {
    if (!this.currentVote) {
      return { success: false, message: '생성된 투표가 없습니다.' };
    }

    this.currentVote.isActive = true;
    this.currentVote.startTime = Date.now();

    // 타이머 설정
    if (this.currentVote.durationSeconds > 0) {
      this.currentVote.timer = setTimeout(() => {
        this.endVote();
      }, this.currentVote.durationSeconds * 1000);
    }

    const optionsText = this.currentVote.options.map(o => `${o.id}.${o.text}`).join(' ');
    this.chat?.sendChat(`📊 투표 시작! "${this.currentVote.question}" - !투표 [번호]로 참여하세요! (${optionsText}) [${this.currentVote.durationSeconds}초]`);

    this.notifyStateChange('voteUpdate', this.getVoteState());
    return { success: true };
  }

  endVote(): { success: boolean; results?: { [key: string]: number }; message?: string } {
    if (!this.currentVote) {
      return { success: false, message: '진행 중인 투표가 없습니다.' };
    }

    if (this.currentVote.timer) {
      clearTimeout(this.currentVote.timer);
      this.currentVote.timer = null;
    }

    this.currentVote.isActive = false;
    const results = { ...this.currentVote.results };

    // 결과 발표
    const totalVotes = Object.values(results).reduce((sum, count) => sum + count, 0);
    const resultsText = this.currentVote.options.map(o => {
      const count = results[o.id] || 0;
      const pct = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : '0';
      return `${o.text}: ${count}표(${pct}%)`;
    }).join(', ');

    this.chat?.sendChat(`📊 투표 종료! "${this.currentVote.question}" 결과: ${resultsText}`);

    this.notifyStateChange('voteUpdate', this.getVoteState());
    return { success: true, results };
  }

  resetVote(): { success: boolean } {
    if (this.currentVote?.timer) {
      clearTimeout(this.currentVote.timer);
    }
    this.currentVote = null;
    this.notifyStateChange('voteUpdate', this.getVoteState());
    return { success: true };
  }

  drawVoteWinner(count: number = 1, optionId?: string): { success: boolean; winners?: any[]; message?: string } {
    if (!this.currentVote) {
      return { success: false, message: '투표가 없습니다.' };
    }

    let candidates = this.currentVote.voterChoices;
    if (optionId) {
      candidates = candidates.filter(v => v.optionId === optionId);
    }

    if (candidates.length === 0) {
      return { success: false, message: '추첨할 참여자가 없습니다.' };
    }

    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, Math.min(count, candidates.length));

    return { success: true, winners, message: `${winners.length}명 추첨 완료!` };
  }

  getVoteState() {
    if (!this.currentVote) return null;
    return {
      id: this.currentVote.id,
      question: this.currentVote.question,
      options: this.currentVote.options,
      results: this.currentVote.results,
      isActive: this.currentVote.isActive,
      durationSeconds: this.currentVote.durationSeconds,
      startTime: this.currentVote.startTime,
      voterCount: this.currentVote.voters.size,
      voterChoices: this.currentVote.voterChoices,
    };
  }

  // ========== 시청자 추첨 관리 ==========
  startDraw(keyword: string = '!참여', settings?: Partial<DrawSession['settings']>): { success: boolean; message?: string } {
    if (this.currentDraw?.isCollecting) {
      return { success: false, message: '이미 참여자를 모집 중입니다.' };
    }

    this.currentDraw = {
      id: uuidv4(),
      isActive: true,
      isCollecting: true,
      keyword,
      participants: [],
      winners: [],
      settings: {
        subscriberOnly: false,
        excludePreviousWinners: true,
        maxParticipants: 0,
        winnerCount: 1,
        ...settings,
      },
    };

    this.chat?.sendChat(`🎲 시청자 추첨이 시작되었습니다! '${keyword}'를 입력해 참여해주세요!`);
    this.notifyStateChange('drawUpdate', this.getDrawState());
    return { success: true };
  }

  stopDrawCollecting(): { success: boolean; participantCount?: number; message?: string } {
    if (!this.currentDraw?.isCollecting) {
      return { success: false, message: '진행 중인 모집이 없습니다.' };
    }

    this.currentDraw.isCollecting = false;
    const count = this.currentDraw.participants.length;

    this.chat?.sendChat(`⏰ 시청자 추첨 참여가 마감되었습니다! (총 ${count}명 참여)`);
    this.notifyStateChange('drawUpdate', this.getDrawState());
    return { success: true, participantCount: count };
  }

  private addDrawParticipant(chat: ChatEvent): void {
    if (!this.currentDraw?.isCollecting) return;

    const userIdHash = chat.profile.userIdHash;

    // 중복 참여 체크
    if (this.currentDraw.participants.some(p => p.userIdHash === userIdHash)) {
      return;
    }

    // 이전 당첨자 제외
    if (this.currentDraw.settings.excludePreviousWinners && this.previousDrawWinners.has(userIdHash)) {
      return;
    }

    // 최대 참여자 수 체크
    if (this.currentDraw.settings.maxParticipants > 0 &&
        this.currentDraw.participants.length >= this.currentDraw.settings.maxParticipants) {
      return;
    }

    this.currentDraw.participants.push({
      userIdHash,
      nickname: chat.profile.nickname,
      joinedAt: Date.now(),
    });

    this.notifyStateChange('drawUpdate', this.getDrawState());
  }

  executeDraw(count?: number): { success: boolean; winners?: any[]; allParticipants?: string[]; animationDuration?: number; message?: string } {
    if (!this.currentDraw) {
      return { success: false, message: '추첨 세션이 없습니다.' };
    }

    if (this.currentDraw.isCollecting) {
      return { success: false, message: '먼저 참여 모집을 마감해주세요.' };
    }

    if (this.currentDraw.participants.length === 0) {
      return { success: false, message: '참여자가 없습니다.' };
    }

    const winnerCount = count || this.currentDraw.settings.winnerCount;
    const actualCount = Math.min(winnerCount, this.currentDraw.participants.length);
    const allParticipants = this.currentDraw.participants.map(p => p.nickname);

    const shuffled = [...this.currentDraw.participants].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, actualCount);

    this.currentDraw.winners = winners.map(w => ({ userIdHash: w.userIdHash, nickname: w.nickname }));
    this.currentDraw.isActive = false;

    winners.forEach(w => this.previousDrawWinners.add(w.userIdHash));

    const animationDuration = 3000 + Math.random() * 2000;

    this.notifyStateChange('drawUpdate', this.getDrawState());

    return {
      success: true,
      winners,
      allParticipants,
      animationDuration,
      message: `🎉 당첨자: ${winners.map(w => w.nickname).join(', ')}`
    };
  }

  resetDraw(): { success: boolean } {
    this.currentDraw = null;
    this.notifyStateChange('drawUpdate', this.getDrawState());
    return { success: true };
  }

  clearPreviousWinners(): { success: boolean } {
    this.previousDrawWinners.clear();
    return { success: true };
  }

  getDrawState() {
    return {
      currentSession: this.currentDraw,
      previousWinnersCount: this.previousDrawWinners.size,
    };
  }

  // ========== 룰렛 관리 ==========
  createRoulette(items: { text: string; weight: number }[]): { success: boolean; message?: string } {
    if (items.length < 2) {
      return { success: false, message: '룰렛 항목은 최소 2개 이상이어야 합니다.' };
    }

    this.rouletteItems = items.map((item, index) => ({
      id: uuidv4(),
      text: item.text,
      weight: item.weight || 1,
      color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    }));

    this.notifyStateChange('rouletteUpdate', this.getRouletteState());
    return { success: true, message: '룰렛이 생성되었습니다.' };
  }

  spinRoulette(): { success: boolean; result?: RouletteItem; spinDegree?: number; animationDuration?: number; message?: string } {
    if (this.rouletteItems.length === 0) {
      return { success: false, message: '룰렛이 없습니다.' };
    }

    // 가중치 기반 랜덤 선택
    const totalWeight = this.rouletteItems.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;

    let selectedItem: RouletteItem | null = null;
    let selectedIndex = 0;

    for (let i = 0; i < this.rouletteItems.length; i++) {
      random -= this.rouletteItems[i].weight;
      if (random <= 0) {
        selectedItem = this.rouletteItems[i];
        selectedIndex = i;
        break;
      }
    }

    if (!selectedItem) {
      selectedItem = this.rouletteItems[this.rouletteItems.length - 1];
      selectedIndex = this.rouletteItems.length - 1;
    }

    // 회전 각도 계산
    const itemAngle = 360 / this.rouletteItems.length;
    const baseRotation = 360 * (5 + Math.floor(Math.random() * 3));
    const randomOffset = (Math.random() * 0.6 + 0.2) * itemAngle;
    const targetAngle = selectedIndex * itemAngle + randomOffset;
    const spinDegree = baseRotation + (360 - targetAngle);

    const animationDuration = 4000 + Math.random() * 2000;

    this.chat?.sendChat(`🎰 룰렛 결과: ${selectedItem.text}!`);
    this.notifyStateChange('rouletteUpdate', this.getRouletteState());

    return {
      success: true,
      result: selectedItem,
      spinDegree,
      animationDuration,
      message: `🎰 결과: ${selectedItem.text}`
    };
  }

  resetRoulette(): { success: boolean } {
    this.rouletteItems = [];
    this.notifyStateChange('rouletteUpdate', this.getRouletteState());
    return { success: true };
  }

  getRouletteState() {
    return {
      items: this.rouletteItems,
    };
  }

  // ========== 유틸리티 ==========
  isConnected(): boolean {
    return this.chat?.connected ?? false;
  }

  sendChat(message: string): void {
    this.chat?.sendChat(message);
  }

  getUserId(): string {
    return this.userId;
  }

  getChannelId(): string {
    return this.channelId;
  }
}
