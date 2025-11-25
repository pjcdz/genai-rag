export interface Source {
  uri: string;
  title: string;
  type: 'web' | 'file';
}

export interface Message {
  role: 'user' | 'dot' | 'system';
  text: string;
  sources?: Source[];
  isStreaming?: boolean;
  charDelay?: number;
  tokenCount?: number;
}
