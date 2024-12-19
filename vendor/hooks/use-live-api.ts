/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MultimodalLiveAPIClientConnection,
  MultimodalLiveClient,
} from "../lib/multimodal-live-client";
import { LiveConfig, LiveOutgoingMessage, ServerContentMessage, RealtimeInputMessage, ClientContentMessage, ModelTurn, ServerContent } from "../multimodal-live-types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";
import { GenerativeContentBlob, Part } from "@google/generative-ai";
import { nanoid } from 'nanoid'


export type UseLiveAPIResults = {
  client: MultimodalLiveClient;
  setConfig: (config: LiveConfig) => void;
  config: LiveConfig;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
  currentUserMessage: RealtimeInputMessage | ClientContentMessage | null;
  currentBotMessage: ServerContentMessage | null;
};

export function useLiveAPI({
  url,
  apiKey,
}: MultimodalLiveAPIClientConnection): UseLiveAPIResults {
  const client = useMemo(
    () => new MultimodalLiveClient({ url, apiKey }),
    [url, apiKey],
  );
  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConfig>({
    model: "models/gemini-2.0-flash-exp",
  });
  const [volume, setVolume] = useState(0);
  // current message
  const [currentUserMessage, setCurrentUserMessage] = useState<RealtimeInputMessage | ClientContentMessage | null>(null);
  const [currentBotMessage, setCurrentBotMessage] = useState<ServerContentMessage | null>(null);
  // 服务端返回的语音，一方面直接播放，另一方面需要保存起来，结束的时候，生成一个播放地址
  const botAudioParts = useRef<Part[]>([]);
  const botContentParts = useRef<Part[]>([]);
  // 用户输入的语音/图片需要保存起来，结束的时候生成语音/视频？
  const mediaChunks = useRef<GenerativeContentBlob[]>([]);
  const userContentParts = useRef<Part[]>([]);

  // register audio for streaming server -> speakers
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: "audio-out" }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          .addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            // Successfully added worklet
          });
      });
    }
  }, [audioStreamerRef]);

  useEffect(() => {
    const onClose = () => {
      setConnected(false);
    };

    const stopAudioStreamer = () => audioStreamerRef.current?.stop();

    const onAudio = (data: ArrayBuffer) =>
      audioStreamerRef.current?.addPCM16(new Uint8Array(data));

    client
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio);

    return () => {
      client
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio);
    };
  }, [client]);

  useEffect(() => {
    let currentUserMessageId: string | null = null
    let currentBotMessageId: string | null = null
    const sendUserRealtimeInput = () => {
      // 如果正在处理机器人语音，就不在中间截取短暂的用户语音
      if (currentUserMessageId && mediaChunks.current?.length > 5 && !currentBotMessageId) {
        setCurrentUserMessage({
          clientContent: {
            turns: [{
              parts: userContentParts.current ?? []
            }],
          },
          realtimeInput: {
            mediaChunks: mediaChunks?.current,
          },
          id: currentUserMessageId,
        })
        currentUserMessageId = null  // 生成一个新的id?
        mediaChunks.current = []  // 清空mediaChunks
        userContentParts.current = []
      }
    }
    const onAudioContent = (data: ModelTurn['modelTurn']['parts']) => {
      sendUserRealtimeInput();
      // 保存结果到botAudioParts
      botAudioParts.current = [...botAudioParts.current, ...data]
      // start empty message
      if (!currentBotMessageId) {
        currentBotMessageId = nanoid()  // new nanoid
        setCurrentBotMessage({
          serverContent: {
            modelTurn: {
              parts: [],  // 空消息，展示loading
            }
          },
          id: currentBotMessageId as string,
        })
      }
    }
    const onContent = (content: ModelTurn) => {
      sendUserRealtimeInput();
      // 文本输出，将文本放到bot message里面
      if (content.modelTurn?.parts) {
        if (!currentBotMessageId) currentBotMessageId = nanoid();
        botContentParts.current.push(...content.modelTurn?.parts)  
        // 这里需要先设置文本消息，支持实时的打字机效果
        setCurrentBotMessage({
          serverContent: {
            modelTurn: {
              // 这里只有文本消息，语音消息只在最后收到turncomplete的时候再一次性发过去
              parts: botContentParts.current,
            }
          },
          id: currentBotMessageId as string,
        })
      }
		}
		const onInterrupted = () => {
			// 这个事件应该表示的是，机器人的语音消息被打断？实际上应该算用户语音输入开始
			console.log('onInterrupted')
		}
		const onTurnComplete = () => {
			// 这个事件表示机器人生成的消息结束了，不管是文本结束还是语音结束，都有这个消息
			console.log('onTurnComplete')
			if (botContentParts.current?.length || botAudioParts.current?.length) {
        if (!currentBotMessageId) currentBotMessageId = nanoid();
        setCurrentBotMessage({
          serverContent: {
            modelTurn: {
              // 文本消息加上语音消息
              parts: [...botContentParts.current, ...botAudioParts.current],
            }
          },
          id: currentBotMessageId as string,
        })
        currentBotMessageId = null
        botContentParts.current = []; // 清空数据
        botAudioParts.current = [];
			}
		}
    const onInput = (data: RealtimeInputMessage | ClientContentMessage) => {
      if (!currentUserMessageId) currentUserMessageId = nanoid();
      if ((data as RealtimeInputMessage)?.realtimeInput?.mediaChunks) {
        mediaChunks.current?.push(...(data as RealtimeInputMessage)?.realtimeInput?.mediaChunks)
        // 这个时候，可以生成一个loading状态的消息？
      }
      if ((data as ClientContentMessage)?.clientContent) {
        // 用户输入了就会有一个turnComplete，立即结束
        const parts = (data as ClientContentMessage)?.clientContent?.turns?.[0].parts
        if (parts && parts?.length > 0) {
          userContentParts.current.push(...parts);
        }
        setCurrentUserMessage({
          ...data,
          id: currentUserMessageId,
          realtimeInput: {
            mediaChunks: [],
          }
        })
        // 这里不清空，等后面收到回复的时候，再尝试清空
        // currentUserMessageId = nanoid()  // 生成一个新的id?
        // mediaChunks.current = []  // 清空mediaChunks
      }
    }
    client
      .on('interrupted', onInterrupted)
      .on('turncomplete', onTurnComplete)
      .on('content', onContent)
      .on('input', onInput)
      .on('audiocontent', onAudioContent);
    return () => {
      client
        .off('interrupted', onInterrupted)
        .off('turncomplete', onTurnComplete)
        .off('content', onContent)
        .off('input', onInput)
        .off('audiocontent', onAudioContent);
    }
  }, [client])

  const connect = useCallback(async () => {
    console.log(config);
    if (!config) {
      throw new Error("config has not been set");
    }
    client.disconnect();
    await client.connect(config);
    setConnected(true);
  }, [client, setConnected, config]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    setConnected(false);
  }, [setConnected, client]);

  return {
    client,
    config,
    setConfig,
    connected,
    connect,
    disconnect,
    volume,
    currentUserMessage,
    currentBotMessage,
  };
}
