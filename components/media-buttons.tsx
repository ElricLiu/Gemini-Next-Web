import { memo, ReactNode, RefObject, useEffect, useRef, useState } from 'react';
import { useLiveAPIContext } from '@/vendor/contexts/LiveAPIContext';
import { UseMediaStreamResult } from '@/vendor/hooks/use-media-stream-mux';
import { useScreenCapture } from '@/vendor/hooks/use-screen-capture';
import { useWebcam } from '@/vendor/hooks/use-webcam';
import { AudioRecorder } from '@/vendor/lib/audio-recorder';
import {
	AudioOutlined,
	AudioMutedOutlined,
	VideoCameraOutlined,
	DesktopOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';

export type MediaButtonsProps = {
	videoRef: RefObject<HTMLVideoElement>;
	children?: ReactNode;
	supportsVideo: boolean;
	onVideoStreamChange?: (stream: MediaStream | null) => void;
};

type MediaStreamButtonProps = {
	isStreaming: boolean;
	onIcon: React.ReactNode;
	offIcon: React.ReactNode;
	start: () => Promise<void>;
	stop: () => void;
};

/**
 * button used for triggering webcam or screen-capture
 */
const MediaStreamButton = memo(
	({ isStreaming, onIcon, offIcon, start, stop }: MediaStreamButtonProps) =>
		isStreaming ? (
			<Button
				type='primary'
				shape='circle'
				icon={onIcon}
				onClick={stop}
				style={{ marginLeft: 10 }}
			/>
		) : (
			<Button
				type='default'
				shape='circle'
				icon={offIcon}
				onClick={start}
				style={{ marginLeft: 10 }}
			/>
		)
);

function MediaButtons({
	videoRef,
	children,
	onVideoStreamChange = () => {},
	supportsVideo,
}: MediaButtonsProps) {
	const videoStreams = [useWebcam(), useScreenCapture()];
	const [activeVideoStream, setActiveVideoStream] =
		useState<MediaStream | null>(null);
	const [webcam, screenCapture] = videoStreams;
	const [inVolume, setInVolume] = useState(0);
	const [audioRecorder] = useState(() => new AudioRecorder());
	const [muted, setMuted] = useState(true); // 设置初始状态为静音
	const renderCanvasRef = useRef<HTMLCanvasElement>(null);

	const { client, connected } = useLiveAPIContext();

	useEffect(() => {
		document.documentElement.style.setProperty(
			'--volume',
			`${Math.max(5, Math.min(inVolume * 200, 8))}px`
		);
	}, [inVolume]);

	useEffect(() => {
		const resetState = () => {
			webcam.stop();
			screenCapture.stop();
			audioRecorder.stop();
			setMuted(true);
			setActiveVideoStream(null);
			onVideoStreamChange(null);
			setInVolume(0);
		};

		client.on('close', resetState);

		return () => {
			client.off('close', resetState);
		};
	}, [client, webcam, screenCapture, audioRecorder, onVideoStreamChange]);

	useEffect(() => {
		const onData = (base64: string) => {
			client.sendRealtimeInput([
				{
					mimeType: 'audio/pcm;rate=16000',
					data: base64,
				},
			]);
		};
		if (connected && !muted && audioRecorder) {
			audioRecorder.on('data', onData).on('volume', setInVolume).start();
		} else {
			audioRecorder.stop();
		}
		return () => {
			audioRecorder.off('data', onData).off('volume', setInVolume);
		};
	}, [connected, client, muted, audioRecorder]);

	useEffect(() => {
		if (videoRef.current) {
			videoRef.current.srcObject = activeVideoStream;
		}

		let timeoutId = -1;

		function sendVideoFrame() {
			const video = videoRef.current;
			const canvas = renderCanvasRef.current;

			if (!video || !canvas) {
				return;
			}

			const ctx = canvas.getContext('2d')!;
			canvas.width = video.videoWidth * 0.25;
			canvas.height = video.videoHeight * 0.25;
			if (canvas.width + canvas.height > 0) {
				ctx.drawImage(
					videoRef.current,
					0,
					0,
					canvas.width,
					canvas.height
				);
				const base64 = canvas.toDataURL('image/jpeg', 1.0);
				const data = base64.slice(base64.indexOf(',') + 1, Infinity);
				client.sendRealtimeInput([{ mimeType: 'image/jpeg', data }]);
			}
			if (connected) {
				timeoutId = window.setTimeout(sendVideoFrame, 1000 / 0.5);
			}
		}
		if (connected && activeVideoStream !== null) {
			requestAnimationFrame(sendVideoFrame);
		}
		return () => {
			clearTimeout(timeoutId);
		};
	}, [connected, activeVideoStream, client, videoRef]);

	//handler for swapping from one video-stream to the next
	const changeStreams = (next?: UseMediaStreamResult) => async () => {
		if (!connected) return;

		if (next) {
			const mediaStream = await next.start();
			setActiveVideoStream(mediaStream);
			onVideoStreamChange(mediaStream);
		} else {
			setActiveVideoStream(null);
			onVideoStreamChange(null);
		}

		videoStreams.filter((msr) => msr !== next).forEach((msr) => msr.stop());
	};

	return (
		<div className='control-tray'>
			<canvas style={{ display: 'none' }} ref={renderCanvasRef} />
			<div>
				<Button
					type={!muted && connected ? 'primary' : 'default'}
					shape='circle'
					icon={!muted ? <AudioOutlined /> : <AudioMutedOutlined />}
					onClick={() => setMuted(!muted)}
				/>
				{supportsVideo && (
					<>
						<MediaStreamButton
							isStreaming={webcam.isStreaming}
							start={changeStreams(webcam)}
							stop={changeStreams()}
							onIcon={<VideoCameraOutlined />}
							offIcon={<VideoCameraOutlined />}
						/>
						<MediaStreamButton
							isStreaming={screenCapture.isStreaming}
							start={changeStreams(screenCapture)}
							stop={changeStreams()}
							onIcon={<DesktopOutlined />}
							offIcon={<DesktopOutlined />}
						/>
					</>
				)}
				{children}
			</div>
		</div>
	);
}

export default memo(MediaButtons);
