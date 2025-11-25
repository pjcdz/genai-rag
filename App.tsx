import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Chat, FileSearchStore, Part } from '@google/genai';
import { Message, Source } from './types';

type UploadedFile = {
  status: 'uploading' | 'indexing' | 'ready' | 'failed';
  name: string;
  uri?: string;
  mimeType?: string;
  isImage?: boolean;
};

const Typewriter: React.FC<{ textToType: string; charDelay: number }> = ({ textToType, charDelay }) => {
  const [displayedText, setDisplayedText] = useState('');
  
  const textIndexRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const timeAccumulatorRef = useRef<number>(0);

  useEffect(() => {
    if (!textToType.startsWith(displayedText)) {
        setDisplayedText('');
        textIndexRef.current = 0;
    }
  }, [textToType, displayedText]);

  useEffect(() => {
    textIndexRef.current = displayedText.length;

    const animate = (currentTime: number) => {
      if (!lastFrameTimeRef.current) {
        lastFrameTimeRef.current = currentTime;
      }
      
      const deltaTime = currentTime - lastFrameTimeRef.current;
      lastFrameTimeRef.current = currentTime;
      timeAccumulatorRef.current += deltaTime;
      
      const effectiveDelay = Math.max(0.1, charDelay);
      const charsToRender = Math.floor(timeAccumulatorRef.current / effectiveDelay);

      if (charsToRender > 0) {
        const newIndex = Math.min(textIndexRef.current + charsToRender, textToType.length);
        if (newIndex > textIndexRef.current) {
          setDisplayedText(textToType.substring(0, newIndex));
          textIndexRef.current = newIndex;
          timeAccumulatorRef.current -= charsToRender * effectiveDelay;
        }
      }

      if (textIndexRef.current < textToType.length) {
        frameRef.current = requestAnimationFrame(animate);
      }
    };
    
    if (displayedText.length < textToType.length) {
        frameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
      lastFrameTimeRef.current = 0;
      timeAccumulatorRef.current = 0;
    };
  }, [textToType, charDelay, displayedText]);

  return <>{displayedText}</>;
};

const sanitizeResourceName = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') 
    .replace(/-+/g, '-')          
    .replace(/^-|-$/g, '');       
};


const App: React.FC = () => {
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  
  const [isApiKeySelected, setIsApiKeySelected] = useState<boolean>(false);
  const [isVerifyingKey, setIsVerifyingKey] = useState<boolean>(true); 
  const [welcomeError, setWelcomeError] = useState<string | null>(null);

  const [fileSearchStore, setFileSearchStore] = useState<FileSearchStore | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<Map<string, UploadedFile>>(new Map());
  const [isUploading, setIsUploading] = useState<boolean>(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const usageMetadataRef = useRef<{ totalTokenCount?: number } | null>(null);

  const initializeChat = useCallback(async (storeName?: string) => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
    const tools = storeName
      ? [{ fileSearch: { fileSearchStoreNames: [storeName] } }]
      : [{ googleSearch: {} }];

    const chatSession = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: 'ur a gen z ai, like, super chill and kinda over it, but also u have access to some secret docs. keep it brief, no caps, no periods. just the vibes, u know? always answer in english, no matter what language the user writes in.',
        tools: tools,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    setChat(chatSession);
  }, []);

  const verifyApiKey = useCallback(async () => {
    setIsVerifyingKey(true);
    setWelcomeError(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      await ai.fileSearchStores.list();
      setIsApiKeySelected(true);
      await initializeChat();
    } catch (error) {
      console.error("API Key verification failed:", error);
      setIsApiKeySelected(false);
      throw error;
    } finally {
      setIsVerifyingKey(false);
    }
  }, [initializeChat]);


  useEffect(() => {
    const checkAndInit = () => {
      setTimeout(async () => {
          if (window.aistudio) {
              const hasKey = await window.aistudio.hasSelectedApiKey();
              if (hasKey) {
                  try {
                    await verifyApiKey();
                  } catch (e) {
                    setWelcomeError("Your previously selected key is invalid. Please select a new one.");
                  }
              } else {
                  setIsVerifyingKey(false);
              }
          } else {
              try {
                await verifyApiKey();
              } catch (e) {
                setWelcomeError("Could not initialize the AI. Please check your API key setup.");
              }
          }
      }, 100);
    };
    checkAndInit();
  }, [verifyApiKey]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!isLoading && isApiKeySelected) {
      inputRef.current?.focus();
    }
  }, [isLoading, isApiKeySelected]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSelectKey = async () => {
      if (window.aistudio) {
          await window.aistudio.openSelectKey();
          try {
            await verifyApiKey();
            setMessages([]);
            setFileSearchStore(null);
            setUploadedFiles(new Map());
          } catch(e) {
            setWelcomeError("The selected key is not valid. Please ensure it's from a project with billing enabled.");
          }
      }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) return;
    const files: File[] = Array.from(event.target.files);
    event.target.value = '';

    // Focus input so user can type while files upload
    inputRef.current?.focus();

    setIsUploading(true);
    setMessages(prev => [...prev, { role: 'system', text: `uploading ${files.length} file(s)...` }]);
    
    setUploadedFiles(prev => {
        const newMap = new Map(prev);
        files.forEach(file => {
            newMap.set(file.name, { name: file.name, status: 'uploading' });
        });
        return newMap;
    });

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
        
        let currentStore = fileSearchStore;
        
        // Only create a store if we have documents (non-images) and no store exists yet.
        const docFiles = files.filter(f => !f.type.startsWith('image/'));
        
        if (!currentStore && docFiles.length > 0) {
            setMessages(prev => [...prev, { role: 'system', text: 'creating a new file collection...' }]);
            const newStore = await ai.fileSearchStores.create({
                config: { displayName: `minimalist-chat-store-${Date.now()}` }
            });
            setFileSearchStore(newStore);
            currentStore = newStore;
        }

        let successes = 0;
        let failures = 0;
        let billingErrorFound = false;

        // Process files sequentially to avoid 500 errors and race conditions
        for (const file of files) {
            try {
                let resourceName = sanitizeResourceName(file.name);
                if (!resourceName) resourceName = 'file';
                
                const timestamp = Date.now().toString();
                const randomSuffix = Math.floor(Math.random() * 100000).toString();
                const maxNameLength = 40 - timestamp.length - randomSuffix.length - 2; 
                const truncatedResourceName = resourceName.substring(0, maxNameLength);
                const uniqueResourceName = `${truncatedResourceName}-${timestamp}-${randomSuffix}`;

                // 1. Upload the file
                const uploadedFile = await ai.files.upload({
                  file,
                  config: {
                    name: uniqueResourceName,
                    displayName: file.name,
                  },
                });
                
                const isImage = uploadedFile.mimeType.startsWith('image/');

                if (isImage) {
                     // 2a. If Image: Mark ready immediately (skip File Search import)
                     setUploadedFiles(prev => {
                        const m = new Map(prev);
                        m.set(file.name, { 
                            name: file.name, 
                            status: 'ready', 
                            uri: uploadedFile.uri,
                            mimeType: uploadedFile.mimeType,
                            isImage: true
                        });
                        return m;
                    });
                    successes++;
                    continue; // Skip import for images
                }

                // 2b. If Document: Import to File Search Store
                if (!currentStore?.name) {
                    // Should have been created above, but defensive check
                     const newStore = await ai.fileSearchStores.create({
                        config: { displayName: `minimalist-chat-store-${Date.now()}` }
                    });
                    setFileSearchStore(newStore);
                    currentStore = newStore;
                }

                setUploadedFiles(prev => {
                    const m = new Map(prev);
                    m.set(file.name, { name: file.name, status: 'indexing' });
                    return m;
                });

                let operation = await ai.fileSearchStores.importFile({
                    fileSearchStoreName: currentStore.name,
                    fileName: uploadedFile.name
                });

                // Poll for completion
                while (!operation.done) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    operation = await ai.operations.get({ operation });
                }
                
                setUploadedFiles(prev => {
                    const m = new Map(prev);
                    m.set(file.name, { name: file.name, status: 'ready' });
                    return m;
                });
                successes++;

            } catch (error: any) {
                console.error("File processing failed for " + file.name, error);
                failures++;
                const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                if (errorMessage.includes("Requested entity was not found")) {
                    billingErrorFound = true;
                }
                
                setUploadedFiles(prev => {
                    const m = new Map(prev);
                    m.set(file.name, { name: file.name, status: 'failed' });
                    return m;
                });
            }
        }

        // Post-processing messages
        if (successes > 0) {
             if (!fileSearchStore && currentStore) {
                  // If we just created the store, re-init chat to include it
                  await initializeChat(currentStore.name);
                  setMessages(prev => [...prev, { role: 'system', text: `${successes} file(s) processed. chat context updated.` }]);
             } else {
                  setMessages(prev => [...prev, { role: 'system', text: `${successes} file(s) ready.` }]);
             }
        }
        
        if (failures > 0) {
             if (billingErrorFound) {
                 setMessages(prev => [...prev, { role: 'system', text: `upload failed. please check api key billing.` }]);
                 if (window.aistudio) {
                    setWelcomeError("The current API key failed. Please select a valid key.");
                    setIsApiKeySelected(false);
                 }
             } else {
                 setMessages(prev => [...prev, { role: 'system', text: `${failures} file(s) failed.` }]);
             }
        }

    } catch (error) {
        console.error("Batch process error:", error);
        setMessages(prev => [...prev, { role: 'system', text: `process failed: ${error}` }]);
        setUploadedFiles(prev => {
             const newMap = new Map<string, UploadedFile>(prev);
             files.forEach(f => {
                 if (newMap.get(f.name)?.status === 'uploading') {
                      newMap.set(f.name, { name: f.name, status: 'failed' });
                 }
             });
             return newMap;
        });
    } finally {
        setIsUploading(false);
    }
  };

  const handleSendMessage = useCallback(async () => {
    // Prevent sending if empty, loading, or currently uploading files
    if (!userInput.trim() || isLoading || !chat || isUploading) return;

    setIsLoading(true);
    const currentUserInput = userInput;
    setUserInput('');
    usageMetadataRef.current = null;
    
    // Identify pending images to attach
    const pendingImages = (Array.from(uploadedFiles.values()) as UploadedFile[])
        .filter(f => f.status === 'ready' && f.isImage && f.uri && f.mimeType);
        
    let displayInput = currentUserInput;
    if (pendingImages.length > 0) {
        displayInput += `\n[attached ${pendingImages.length} image(s)]`;
    }

    setMessages(prev => [
      ...prev,
      { role: 'user', text: displayInput },
      { role: 'dot', text: '', sources: [], isStreaming: true, charDelay: 20 },
    ]);

    try {
      // Construct the message payload with images if present
      let messagePayload: string | Part[] = currentUserInput;
      
      if (pendingImages.length > 0) {
          const parts: Part[] = [ { text: currentUserInput } ];
          pendingImages.forEach(img => {
              if (img.uri && img.mimeType) {
                  parts.push({
                      fileData: {
                          fileUri: img.uri,
                          mimeType: img.mimeType
                      }
                  });
              }
          });
          messagePayload = parts;
      }

      const stream = await chat.sendMessageStream({ message: messagePayload });

      // Clean up sent images from the "context" list
      if (pendingImages.length > 0) {
           setUploadedFiles(prev => {
               const next = new Map(prev);
               pendingImages.forEach(img => next.delete(img.name));
               return next;
           });
      }

      let totalText = '';
      let sources: Source[] = [];
      let lastChunkTime = performance.now();
      let smoothedCharDelay = 20;
      const smoothingFactor = 0.4;

      for await (const chunk of stream) {
        if (chunk.usageMetadata && !usageMetadataRef.current) {
          usageMetadataRef.current = chunk.usageMetadata;
        }

        const now = performance.now();
        
        let newText = '';
        if (chunk.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
                if (part.text) {
                    newText += part.text;
                }
            }
        }
        
        const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (groundingChunks) {
          for (const groundingChunk of groundingChunks) {
            if (groundingChunk.web) {
              if (!sources.some(s => s.uri === groundingChunk.web.uri)) {
                sources.push({ type: 'web', uri: groundingChunk.web.uri, title: groundingChunk.web.title || groundingChunk.web.uri });
              }
            } else if (groundingChunk.retrievedContext) {
               if (!sources.some(s => s.uri === groundingChunk.retrievedContext.uri)) {
                sources.push({ type: 'file', uri: groundingChunk.retrievedContext.uri, title: groundingChunk.retrievedContext.title || groundingChunk.retrievedContext.uri });
              }
            }
          }
        }
        
        if (!newText) continue;

        const deltaTime = now - lastChunkTime;
        const deltaChars = newText.length;

        if (deltaTime > 1 && deltaChars > 0) {
          const charsPerSecond = (deltaChars / deltaTime) * 1000;
          const newCharDelay = 1000 / charsPerSecond;
          smoothedCharDelay = (smoothingFactor * newCharDelay) + ((1 - smoothingFactor) * smoothedCharDelay);
        }
        
        totalText += newText;
        lastChunkTime = now;

        setMessages(prev => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage && lastMessage.role === 'dot') {
            lastMessage.text = totalText;
            lastMessage.sources = [...sources];
            lastMessage.charDelay = Math.max(0.1, smoothedCharDelay);
          }
          return newMessages;
        });
      }
    } catch (error) {
      console.error("Error sending message:", error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      setMessages(prev => {
        const newMessages = [...prev];
        const lastMessage = newMessages[newMessages.length - 1];
        if (lastMessage?.role === 'dot' && lastMessage.isStreaming) {
            lastMessage.text = `error lol: ${errorMessage}`;
        } else {
            newMessages.push({ role: 'dot', text: `error lol: ${errorMessage}` });
        }
        return newMessages;
      });
    } finally {
      setIsLoading(false);
      setMessages(prev => {
        const newMessages = [...prev];
        const lastMessage = newMessages[newMessages.length - 1];
        if (lastMessage && lastMessage.role === 'dot') {
          lastMessage.isStreaming = false;
          if (usageMetadataRef.current?.totalTokenCount) {
            lastMessage.tokenCount = usageMetadataRef.current.totalTokenCount;
          }
        }
        return newMessages;
      });
    }
  }, [userInput, isLoading, chat, uploadedFiles, isUploading]);


  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="bg-black text-white font-mono h-screen p-2 text-base md:text-lg focus:outline-none flex flex-col" onClick={() => { if (isApiKeySelected) {inputRef.current?.focus()}}}>
      {!isApiKeySelected ? (
        <div className="flex-grow flex flex-col items-center justify-center text-center p-4">
            <div className="max-w-md">
                <h1 className="text-xl mb-4">welcome</h1>
                <p className="text-gray-400 mb-6">this app uses the file search api, which requires a google cloud project with billing enabled.</p>
                {isVerifyingKey ? (
                  <p className="text-yellow-400 my-4">verifying api key...</p>
                ) : (
                  <>
                    <button
                        onClick={handleSelectKey}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors"
                    >
                        select api key
                    </button>
                    {welcomeError && <p className="text-red-500 mt-4 text-sm">{welcomeError}</p>}
                  </>
                )}
                <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="block text-xs text-blue-400 hover:underline mt-3">
                    learn more about billing and setup
                </a>
            </div>
        </div>
      ) : (
        <>
            <div className="flex-grow overflow-y-auto mb-2">
                {messages.map((msg, index) => (
                    <div key={index}>
                        {msg.role === 'system' ? (
                            <div className="text-gray-500 italic text-sm my-2 text-center">-- {msg.text} --</div>
                        ) : (
                        <>
                            <div className="flex">
                                <span className="flex-shrink-0">{msg.role}: </span>
                                <span className="whitespace-pre-wrap flex-grow break-words">
                                {msg.isStreaming ? (
                                    <Typewriter textToType={msg.text} charDelay={msg.charDelay || 20} />
                                ) : (
                                    msg.text
                                )}
                                </span>
                            </div>
                            {((msg.sources && msg.sources.length > 0) || msg.tokenCount) && !msg.isStreaming && (
                                <div className="text-xs mt-1 flex flex-wrap items-center gap-x-4">
                                {msg.sources && msg.sources.length > 0 && (
                                    <div>
                                    <p className="text-gray-400">sources:</p>
                                    <div className="flex flex-wrap items-center">
                                        {msg.sources.map((source, i) => (
                                            source.type === 'web' ? (
                                                <a
                                                    key={i}
                                                    href={source.uri}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-blue-400 hover:underline mr-4"
                                                    title={source.uri}
                                                >
                                                    [{i + 1}] {source.title}
                                                </a>
                                            ) : (
                                                <span key={i} className="text-green-400 mr-4" title={source.uri}>
                                                    [F{i + 1}] {source.title}
                                                </span>
                                            )
                                        ))}
                                    </div>
                                    </div>
                                )}
                                {msg.tokenCount && (
                                    <div>
                                        <p className="text-gray-400">tokens:</p>
                                        <p className="text-gray-500">{msg.tokenCount}</p>
                                    </div>
                                )}
                                </div>
                            )}
                        </>
                    )}
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            
            <div className="flex-shrink-0">
                {Array.from(uploadedFiles.values()).length > 0 && (
                <div className="text-xs text-gray-400 mb-1 flex flex-wrap gap-2">
                    <span className="font-bold self-center">context:</span>
                    {Array.from(uploadedFiles.values()).map((f: UploadedFile) => (
                    <span key={f.name} className={`px-2 py-1 rounded-full ${f.status === 'ready' ? 'bg-green-900 text-green-300' : f.status === 'failed' ? 'bg-red-900 text-red-300' : 'bg-yellow-900 text-yellow-300'}`}>
                        {f.name} ({f.status})
                    </span>
                    ))}
                </div>
                )}

                {!isLoading && (
                <div className="flex items-center">
                    <span>user: </span>
                    <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="mx-2 text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
                    title="Upload files for context"
                    aria-label="Upload files for context"
                    >
                    📎
                    </button>
                    <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    disabled={isUploading}
                    multiple
                    />
                    <input
                    ref={inputRef}
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="bg-transparent border-none outline-none text-white font-mono w-full p-0 m-0"
                    autoFocus
                    disabled={isLoading}
                    spellCheck="false"
                    />
                </div>
                )}
            </div>
        </>
      )}
    </div>
  );
};

export default App;