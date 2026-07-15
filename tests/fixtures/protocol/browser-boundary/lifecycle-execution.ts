import { spawn } from 'node:child_process';
export const forbidden = () => spawn('npm', ['install']);
