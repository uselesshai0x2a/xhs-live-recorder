import { spawn } from 'node:child_process'
import type { MediaRunner, MediaProcess } from '@xhs-live-recorder/core'

export class FfmpegRunner implements MediaRunner {
  constructor(private binary: string) {}
  start(args: string[]): MediaProcess {
    const child = spawn(this.binary, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    let exited = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16384)
    })
    child.stdin.on('error', () => undefined)
    const completion = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once('error', () => {
        exited = true
        reject(new Error('无法启动内置 FFmpeg，请检查安装文件'))
      })
      child.once('close', (code) => {
        exited = true
        resolve({ code, stderr })
      })
    })
    return {
      completion,
      quit: () => {
        if (!exited && child.stdin.writable) child.stdin.write('q\n')
      },
      kill: () => {
        if (!exited) child.kill('SIGTERM')
      }
    }
  }
}
