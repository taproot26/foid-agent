import './styles.css';

import { useState, useRef, useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  text: string
}

export default function App() {
  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Ingest state
  const [ingestText, setIngestText] = useState('')
  const [ingestSource, setIngestSource] = useState('')
  const [ingestStatus, setIngestStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [ingestLoading, setIngestLoading] = useState(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendChat() {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    setChatInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setChatLoading(true)
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      const reply = data.response ?? data.message ?? JSON.stringify(data)
      setMessages(prev => [...prev, { role: 'assistant', text: reply }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${String(e)}` }])
    } finally {
      setChatLoading(false)
    }
  }

  async function submitIngest() {
    if (!ingestText.trim() || ingestLoading) return
    setIngestLoading(true)
    setIngestStatus(null)
    try {
      const res = await fetch('/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ingestText, source: ingestSource }),
      })
      if (res.ok) {
        setIngestStatus({ ok: true, msg: 'Ingested successfully.' })
        setIngestText('')
        setIngestSource('')
      } else {
        const err = await res.text()
        setIngestStatus({ ok: false, msg: `Error ${res.status}: ${err}` })
      }
    } catch (e) {
      setIngestStatus({ ok: false, msg: `Error: ${String(e)}` })
    } finally {
      setIngestLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24, fontFamily: 'sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      {/* Chat */}

<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
  <button onClick={() => console.log('Toggle theme')} disabled={false} style={{
    padding: '10px', borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', cursor: 'pointer', fontSize: 14,
    opacity: false ? 0.5 : 1
  }}>Toggle Theme</button>
</div>

<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
  <button onClick={() => console.log('Start button clicked')} disabled={false} style={{
    padding: '10px', borderRadius: 8, border: 'none', background: '#28a745', color: '#fff', cursor: 'pointer', fontSize: 14,
    opacity: false ? 0.5 : 1
  }}>Start</button>
</div>
      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
<h2 style="margin: 0; font-weight: bold;">Welcome</h2>
        <div style={{
          flex: 1, minHeight: 400, maxHeight: 500, overflowY: 'auto',
          border: '1px solid #ddd', borderRadius: 8, padding: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
          background: '#fafafa',
        }}>
          {messages.length === 0 && (
            <span style={{ color: '#aaa', alignSelf: 'center', marginTop: 'auto', marginBottom: 'auto' }}>
              No messages yet
            </span>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              background: m.role === 'user' ? '#0070f3' : '#e9e9e9',
              color: m.role === 'user' ? '#fff' : '#000',
              padding: '8px 12px',
              borderRadius: 16,
              maxWidth: '80%',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {m.text}
            </div>
          ))}
          {chatLoading && (
            <div style={{ alignSelf: 'flex-start', color: '#888', fontStyle: 'italic' }}>
              Thinking...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendChat()}
            placeholder="Type a message..."
            style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}
          />
          <button
            onClick={sendChat}
            disabled={chatLoading || !chatInput.trim()}
            style={{
              padding: '8px 18px', borderRadius: 8, border: 'none',
              background: '#0070f3', color: '#fff', cursor: 'pointer',
              opacity: chatLoading || !chatInput.trim() ? 0.5 : 1,
            }}
          >
            Send
          </button>
        </div>
      </section>

      <div style={{ width: 1, background: '#eee' }} />

      {/* Ingest */}
      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Ingest</h2>
        <textarea
          value={ingestText}
          onChange={e => setIngestText(e.target.value)}
          placeholder="Paste content to ingest..."
          rows={10}
          style={{ padding: 12, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, resize: 'vertical' }}
        />
        <input
          value={ingestSource}
          onChange={e => setIngestSource(e.target.value)}
          placeholder="Source name (optional)"
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14 }}
        />
        <button
          onClick={submitIngest}
          disabled={ingestLoading || !ingestText.trim()}
          style={{
            padding: '10px', borderRadius: 8, border: 'none',
            background: '#28a745', color: '#fff', cursor: 'pointer', fontSize: 14,
            opacity: ingestLoading || !ingestText.trim() ? 0.5 : 1,
          }}
        >
          {ingestLoading ? 'Ingesting...' : 'Ingest'}
        </button>
        {ingestStatus && (
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: ingestStatus.ok ? '#d4edda' : '#f8d7da',
            color: ingestStatus.ok ? '#155724' : '#721c24',
            fontSize: 14,
          }}>
            {ingestStatus.msg}
          </div>
        )}
      </section>
    </div>
  )
}
