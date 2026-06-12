import { useEffect, useRef, useState } from 'react'
import QRCodeStyling from 'qr-code-styling'
import type {
  CornerDotType,
  CornerSquareType,
  DotType,
  ErrorCorrectionLevel,
  FileExtension,
} from 'qr-code-styling'
import { useUtilityConfig } from '../../hooks/useUtilityConfig'
import { useAuth } from '../../auth/auth-context'
import { supabase } from '../../lib/supabase'

/**
 * QR code generator inspired by qr.io: encodes several content types
 * (URL, text, email, phone, SMS, WiFi, vCard, WhatsApp) and offers visual
 * customization — dot/corner shapes, colors, an optional center logo — with
 * PNG/SVG/JPEG/WebP export. Styling preferences persist via useUtilityConfig;
 * the content being encoded stays ephemeral.
 */

type ContentType = 'url' | 'text' | 'email' | 'phone' | 'sms' | 'wifi' | 'vcard' | 'whatsapp'

const CONTENT_TYPES: { id: ContentType; label: string }[] = [
  { id: 'url', label: 'URL' },
  { id: 'text', label: 'Text' },
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone' },
  { id: 'sms', label: 'SMS' },
  { id: 'wifi', label: 'WiFi' },
  { id: 'vcard', label: 'vCard' },
  { id: 'whatsapp', label: 'WhatsApp' },
]

const DOT_TYPES: { id: DotType; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'dots', label: 'Dots' },
  { id: 'classy', label: 'Classy' },
  { id: 'classy-rounded', label: 'Classy rounded' },
  { id: 'extra-rounded', label: 'Extra rounded' },
]

const CORNER_SQUARE_TYPES: { id: CornerSquareType; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'extra-rounded', label: 'Rounded' },
  { id: 'dot', label: 'Dot' },
]

const CORNER_DOT_TYPES: { id: CornerDotType; label: string }[] = [
  { id: 'square', label: 'Square' },
  { id: 'dot', label: 'Dot' },
]

const ERROR_LEVELS: { id: ErrorCorrectionLevel; label: string }[] = [
  { id: 'L', label: 'L · 7%' },
  { id: 'M', label: 'M · 15%' },
  { id: 'Q', label: 'Q · 25%' },
  { id: 'H', label: 'H · 30%' },
]

const DOWNLOAD_FORMATS: FileExtension[] = ['png', 'svg', 'jpeg', 'webp']

interface ContentFields {
  url: string
  text: string
  emailTo: string
  emailSubject: string
  emailBody: string
  phone: string
  smsNumber: string
  smsMessage: string
  wifiSsid: string
  wifiPassword: string
  wifiEncryption: 'WPA' | 'WEP' | 'nopass'
  wifiHidden: boolean
  vcardFirstName: string
  vcardLastName: string
  vcardPhone: string
  vcardEmail: string
  vcardOrg: string
  vcardUrl: string
  whatsappNumber: string
  whatsappMessage: string
}

const EMPTY_FIELDS: ContentFields = {
  url: '',
  text: '',
  emailTo: '',
  emailSubject: '',
  emailBody: '',
  phone: '',
  smsNumber: '',
  smsMessage: '',
  wifiSsid: '',
  wifiPassword: '',
  wifiEncryption: 'WPA',
  wifiHidden: false,
  vcardFirstName: '',
  vcardLastName: '',
  vcardPhone: '',
  vcardEmail: '',
  vcardOrg: '',
  vcardUrl: '',
  whatsappNumber: '',
  whatsappMessage: '',
}

/** WiFi payload syntax requires \ ; , : " to be backslash-escaped. */
function escapeWifi(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1')
}

function buildPayload(type: ContentType, f: ContentFields): string {
  switch (type) {
    case 'url':
      return f.url
    case 'text':
      return f.text
    case 'email': {
      if (!f.emailTo) return ''
      const params = new URLSearchParams()
      if (f.emailSubject) params.set('subject', f.emailSubject)
      if (f.emailBody) params.set('body', f.emailBody)
      const query = params.toString()
      return `mailto:${f.emailTo}${query ? `?${query}` : ''}`
    }
    case 'phone':
      return f.phone ? `tel:${f.phone}` : ''
    case 'sms':
      return f.smsNumber ? `SMSTO:${f.smsNumber}:${f.smsMessage}` : ''
    case 'wifi':
      return f.wifiSsid
        ? `WIFI:T:${f.wifiEncryption};S:${escapeWifi(f.wifiSsid)};P:${escapeWifi(f.wifiPassword)};${f.wifiHidden ? 'H:true;' : ''};`
        : ''
    case 'vcard': {
      const name = [f.vcardFirstName, f.vcardLastName].filter(Boolean).join(' ')
      if (!name) return ''
      return [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:${f.vcardLastName};${f.vcardFirstName};;;`,
        `FN:${name}`,
        f.vcardOrg && `ORG:${f.vcardOrg}`,
        f.vcardPhone && `TEL:${f.vcardPhone}`,
        f.vcardEmail && `EMAIL:${f.vcardEmail}`,
        f.vcardUrl && `URL:${f.vcardUrl}`,
        'END:VCARD',
      ]
        .filter(Boolean)
        .join('\n')
    }
    case 'whatsapp': {
      if (!f.whatsappNumber) return ''
      const number = f.whatsappNumber.replace(/[^\d]/g, '')
      const text = f.whatsappMessage ? `?text=${encodeURIComponent(f.whatsappMessage)}` : ''
      return `https://wa.me/${number}${text}`
    }
  }
}

interface QrDesign {
  contentType: ContentType
  dotsType: DotType
  cornersSquareType: CornerSquareType
  cornersDotType: CornerDotType
  fgColor: string
  bgColor: string
  transparentBg: boolean
  size: number
  errorLevel: ErrorCorrectionLevel
}

/** A saved creation: name + the content fields and design needed to rebuild it. */
interface SavedQr {
  id: string
  name: string
  content_type: ContentType
  created_at: string
  data: {
    fields: ContentFields
    design: QrDesign
  }
}

const inputClass =
  'glass w-full rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 transition-all duration-200 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/20'

const labelClass = 'block text-xs font-medium text-slate-400'

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

export function QRCodeGenerator() {
  const { config, setConfig, loading, saving } = useUtilityConfig('qr-code', {
    contentType: 'url' as ContentType,
    dotsType: 'rounded' as DotType,
    cornersSquareType: 'extra-rounded' as CornerSquareType,
    cornersDotType: 'dot' as CornerDotType,
    fgColor: '#6366f1',
    bgColor: '#ffffff',
    transparentBg: false,
    size: 300,
    errorLevel: 'M' as ErrorCorrectionLevel,
  })
  const { user } = useAuth()
  const [fields, setFields] = useState<ContentFields>(EMPTY_FIELDS)
  const [logo, setLogo] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedQr[]>([])
  const [saveName, setSaveName] = useState('')
  const [savingQr, setSavingQr] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const previewRef = useRef<HTMLDivElement>(null)
  const qrRef = useRef<QRCodeStyling | null>(null)

  const payload = buildPayload(config.contentType, fields)

  useEffect(() => {
    if (loading || !previewRef.current) return
    const options = {
      width: config.size,
      height: config.size,
      data: payload || 'https://example.com',
      image: logo ?? undefined,
      margin: 8,
      qrOptions: { errorCorrectionLevel: config.errorLevel },
      dotsOptions: { color: config.fgColor, type: config.dotsType },
      cornersSquareOptions: { color: config.fgColor, type: config.cornersSquareType },
      cornersDotOptions: { color: config.fgColor, type: config.cornersDotType },
      backgroundOptions: { color: config.transparentBg ? 'transparent' : config.bgColor },
      imageOptions: { margin: 6, imageSize: 0.35 },
    }
    if (!qrRef.current) {
      qrRef.current = new QRCodeStyling(options)
      qrRef.current.append(previewRef.current)
    } else {
      qrRef.current.update(options)
    }
  }, [loading, payload, logo, config])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    supabase
      .from('qr_codes')
      .select('id, name, content_type, created_at, data')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setSaveError(error.message)
        else setSaved((data as SavedQr[]) ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [user])

  async function saveCreation() {
    if (!user || !payload) return
    setSavingQr(true)
    setSaveError(null)
    const name = saveName.trim() || `${config.contentType} · ${payload.slice(0, 40)}`
    const { data, error } = await supabase
      .from('qr_codes')
      .insert({
        user_id: user.id,
        name,
        content_type: config.contentType,
        data: { fields, design: config },
      })
      .select('id, name, content_type, created_at, data')
      .single()
    if (error) setSaveError(error.message)
    else if (data) {
      setSaved((prev) => [data as SavedQr, ...prev])
      setSaveName('')
    }
    setSavingQr(false)
  }

  async function deleteCreation(id: string) {
    setSaved((prev) => prev.filter((s) => s.id !== id))
    const { error } = await supabase.from('qr_codes').delete().eq('id', id)
    if (error) setSaveError(error.message)
  }

  function loadCreation(item: SavedQr) {
    setFields({ ...EMPTY_FIELDS, ...item.data.fields })
    setConfig({ ...item.data.design, contentType: item.content_type })
  }

  function setField<K extends keyof ContentFields>(key: K, value: ContentFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function handleLogoUpload(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setLogo(reader.result as string)
    reader.readAsDataURL(file)
  }

  function download(extension: FileExtension) {
    qrRef.current?.download({ name: `qr-${config.contentType}`, extension })
  }

  if (loading) {
    return <p className="animate-pulse text-slate-400">Loading your settings…</p>
  }

  const c = config.contentType

  return (
    <div className="max-w-5xl animate-fade-up">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">QR Code Generator</h1>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <span
            className={`size-1.5 rounded-full ${saving ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`}
          />
          {saving ? 'Saving…' : 'Settings saved'}
        </span>
      </div>
      <p className="mt-2 text-slate-400">
        Create styled QR codes for links, WiFi, contacts and more. Your design preferences are
        remembered on your account.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_minmax(280px,360px)]">
        <div>
          <div className="flex flex-wrap gap-2">
            {CONTENT_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => setConfig({ contentType: t.id })}
                className={`rounded-xl px-3.5 py-1.5 text-sm transition-all duration-200 ${
                  c === t.id
                    ? 'bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25'
                    : 'border border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-4">
            {c === 'url' && (
              <Field label="Website URL">
                <input
                  type="url"
                  value={fields.url}
                  onChange={(e) => setField('url', e.target.value)}
                  placeholder="https://example.com"
                  className={inputClass}
                />
              </Field>
            )}

            {c === 'text' && (
              <Field label="Text">
                <textarea
                  value={fields.text}
                  onChange={(e) => setField('text', e.target.value)}
                  rows={4}
                  placeholder="Any text to encode…"
                  className={`${inputClass} resize-y`}
                />
              </Field>
            )}

            {c === 'email' && (
              <>
                <Field label="Email address">
                  <input
                    type="email"
                    value={fields.emailTo}
                    onChange={(e) => setField('emailTo', e.target.value)}
                    placeholder="someone@example.com"
                    className={inputClass}
                  />
                </Field>
                <Field label="Subject (optional)">
                  <input
                    value={fields.emailSubject}
                    onChange={(e) => setField('emailSubject', e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Message (optional)">
                  <textarea
                    value={fields.emailBody}
                    onChange={(e) => setField('emailBody', e.target.value)}
                    rows={3}
                    className={`${inputClass} resize-y`}
                  />
                </Field>
              </>
            )}

            {c === 'phone' && (
              <Field label="Phone number">
                <input
                  type="tel"
                  value={fields.phone}
                  onChange={(e) => setField('phone', e.target.value)}
                  placeholder="+32 470 12 34 56"
                  className={inputClass}
                />
              </Field>
            )}

            {c === 'sms' && (
              <>
                <Field label="Phone number">
                  <input
                    type="tel"
                    value={fields.smsNumber}
                    onChange={(e) => setField('smsNumber', e.target.value)}
                    placeholder="+32 470 12 34 56"
                    className={inputClass}
                  />
                </Field>
                <Field label="Message (optional)">
                  <textarea
                    value={fields.smsMessage}
                    onChange={(e) => setField('smsMessage', e.target.value)}
                    rows={3}
                    className={`${inputClass} resize-y`}
                  />
                </Field>
              </>
            )}

            {c === 'wifi' && (
              <>
                <Field label="Network name (SSID)">
                  <input
                    value={fields.wifiSsid}
                    onChange={(e) => setField('wifiSsid', e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Password">
                  <input
                    value={fields.wifiPassword}
                    onChange={(e) => setField('wifiPassword', e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Encryption">
                  <div className="flex gap-2">
                    {(['WPA', 'WEP', 'nopass'] as const).map((enc) => (
                      <button
                        key={enc}
                        onClick={() => setField('wifiEncryption', enc)}
                        className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                          fields.wifiEncryption === enc
                            ? 'bg-indigo-500 text-white'
                            : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {enc === 'nopass' ? 'None' : enc}
                      </button>
                    ))}
                  </div>
                </Field>
                <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={fields.wifiHidden}
                    onChange={(e) => setField('wifiHidden', e.target.checked)}
                    className="size-4 accent-indigo-500"
                  />
                  Hidden network
                </label>
              </>
            )}

            {c === 'vcard' && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name">
                    <input
                      value={fields.vcardFirstName}
                      onChange={(e) => setField('vcardFirstName', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Last name">
                    <input
                      value={fields.vcardLastName}
                      onChange={(e) => setField('vcardLastName', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      type="tel"
                      value={fields.vcardPhone}
                      onChange={(e) => setField('vcardPhone', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      value={fields.vcardEmail}
                      onChange={(e) => setField('vcardEmail', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Company">
                    <input
                      value={fields.vcardOrg}
                      onChange={(e) => setField('vcardOrg', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Website">
                    <input
                      type="url"
                      value={fields.vcardUrl}
                      onChange={(e) => setField('vcardUrl', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </div>
              </>
            )}

            {c === 'whatsapp' && (
              <>
                <Field label="WhatsApp number (with country code)">
                  <input
                    type="tel"
                    value={fields.whatsappNumber}
                    onChange={(e) => setField('whatsappNumber', e.target.value)}
                    placeholder="+32470123456"
                    className={inputClass}
                  />
                </Field>
                <Field label="Pre-filled message (optional)">
                  <textarea
                    value={fields.whatsappMessage}
                    onChange={(e) => setField('whatsappMessage', e.target.value)}
                    rows={3}
                    className={`${inputClass} resize-y`}
                  />
                </Field>
              </>
            )}
          </div>

          <div className="glass mt-8 rounded-2xl p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Design
            </p>

            <div className="mt-4 space-y-4">
              <Field label="Dot style">
                <div className="flex flex-wrap gap-2">
                  {DOT_TYPES.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setConfig({ dotsType: d.id })}
                      className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                        config.dotsType === d.id
                          ? 'bg-indigo-500 text-white'
                          : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Corner frame">
                  <div className="flex flex-wrap gap-2">
                    {CORNER_SQUARE_TYPES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setConfig({ cornersSquareType: t.id })}
                        className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                          config.cornersSquareType === t.id
                            ? 'bg-indigo-500 text-white'
                            : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Corner dot">
                  <div className="flex flex-wrap gap-2">
                    {CORNER_DOT_TYPES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setConfig({ cornersDotType: t.id })}
                        className={`rounded-lg px-3 py-1.5 text-xs transition-all ${
                          config.cornersDotType === t.id
                            ? 'bg-indigo-500 text-white'
                            : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              <div className="flex flex-wrap items-end gap-5">
                <Field label="Code color">
                  <input
                    type="color"
                    value={config.fgColor}
                    onChange={(e) => setConfig({ fgColor: e.target.value })}
                    className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-white/5"
                  />
                </Field>
                <Field label="Background">
                  <input
                    type="color"
                    value={config.bgColor}
                    onChange={(e) => setConfig({ bgColor: e.target.value })}
                    disabled={config.transparentBg}
                    className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-white/5 disabled:opacity-40"
                  />
                </Field>
                <label className="flex cursor-pointer items-center gap-2.5 pb-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={config.transparentBg}
                    onChange={(e) => setConfig({ transparentBg: e.target.checked })}
                    className="size-4 accent-indigo-500"
                  />
                  Transparent background
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Size — ${config.size}px`}>
                  <input
                    type="range"
                    min={200}
                    max={1000}
                    step={20}
                    value={config.size}
                    onChange={(e) => setConfig({ size: Number(e.target.value) })}
                    className="w-full accent-indigo-500"
                  />
                </Field>
                <Field label="Error correction">
                  <div className="flex gap-2">
                    {ERROR_LEVELS.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => setConfig({ errorLevel: l.id })}
                        className={`rounded-lg px-2.5 py-1.5 font-mono text-xs transition-all ${
                          config.errorLevel === l.id
                            ? 'bg-indigo-500 text-white'
                            : 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              <Field label="Center logo (optional)">
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleLogoUpload(e.target.files?.[0])}
                    className="text-sm text-slate-400 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:bg-white/20"
                  />
                  {logo && (
                    <button
                      onClick={() => setLogo(null)}
                      className="text-xs text-slate-400 underline hover:text-white"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>

        <div className="lg:sticky lg:top-8 lg:self-start">
          <div className="glass flex flex-col items-center rounded-2xl p-5">
            <p className="self-start text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Preview
            </p>
            <div
              ref={previewRef}
              className={`mt-4 overflow-hidden rounded-xl transition-opacity [&_canvas]:h-auto [&_canvas]:max-w-full ${
                payload ? '' : 'opacity-30'
              }`}
            />
            {!payload && (
              <p className="mt-3 text-center text-xs text-slate-500">
                Fill in the fields to generate your QR code.
              </p>
            )}
            <div className="mt-5 grid w-full grid-cols-2 gap-2">
              {DOWNLOAD_FORMATS.map((ext) => (
                <button
                  key={ext}
                  onClick={() => download(ext)}
                  disabled={!payload}
                  className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-2 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
                >
                  {ext.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="glass mt-4 rounded-2xl p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Saved codes
            </p>

            <div className="mt-3 flex gap-2">
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Name this QR code…"
                className={inputClass}
              />
              <button
                onClick={saveCreation}
                disabled={!payload || savingQr}
                className="shrink-0 rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-white/20 disabled:opacity-40"
              >
                {savingQr ? 'Saving…' : 'Save'}
              </button>
            </div>
            {saveError && <p className="mt-2 text-xs text-rose-400">{saveError}</p>}

            {saved.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                Nothing saved yet. Save a creation to reload it later on any device.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {saved.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2"
                  >
                    <button
                      onClick={() => loadCreation(item)}
                      className="min-w-0 flex-1 text-left"
                      title="Load this QR code"
                    >
                      <span className="block truncate text-sm text-white">{item.name}</span>
                      <span className="block text-[11px] text-slate-500">
                        {CONTENT_TYPES.find((t) => t.id === item.content_type)?.label ??
                          item.content_type}{' '}
                        · {new Date(item.created_at).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      onClick={() => deleteCreation(item.id)}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
