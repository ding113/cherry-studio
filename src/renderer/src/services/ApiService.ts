import i18n from '@renderer/i18n'
import store from '@renderer/store'
import { setGenerating } from '@renderer/store/runtime'
import { Assistant, Message, Model, Provider, Suggestion } from '@renderer/types'
import { formatMessageError } from '@renderer/utils/error'
import { isEmpty } from 'lodash'

import AiProvider from '../providers/AiProvider'
import {
  getAssistantProvider,
  getDefaultModel,
  getProviderByModel,
  getTopNamingModel,
  getTranslateModel
} from './AssistantService'
import { EVENT_NAMES, EventEmitter } from './EventService'
import { enhanceMessageWithTopicReferences, filterMessages, filterUsefulMessages } from './MessagesService'
import { estimateMessagesUsage } from './TokenService'

export async function fetchChatCompletion({
  message,
  messages,
  assistant,
  onResponse
}: {
  message: Message
  messages: Message[]
  assistant: Assistant
  onResponse: (message: Message) => void
}) {
  console.log('开始fetchChatCompletion:调试', { message, messages, assistant })
  window.keyv.set(EVENT_NAMES.CHAT_COMPLETION_PAUSED, false)

  const provider = getAssistantProvider(assistant)
  console.log('获取到provider:调试', provider)
  const AI = new AiProvider(provider)

  store.dispatch(setGenerating(true))

  onResponse({ ...message })

  // Handle paused state
  let paused = false
  const timer = setInterval(() => {
    if (window.keyv.get(EVENT_NAMES.CHAT_COMPLETION_PAUSED)) {
      console.log('检测到暂停状态:调试')
      paused = true
      message.status = 'paused'
      EventEmitter.emit(EVENT_NAMES.RECEIVE_MESSAGE, message)
      store.dispatch(setGenerating(false))
      onResponse({ ...message, status: 'paused' })
      clearInterval(timer)
    }
  }, 1000)

  try {
    let _messages: Message[] = []
    let isFirstChunk = true

    // 先过滤和增强消息
    const filteredMessages = filterUsefulMessages(messages)
    const enhancedMessages = await enhanceMessageWithTopicReferences(filteredMessages)
    console.log('发送给API的增强消息:调试', enhancedMessages[enhancedMessages.length - 1])

    await AI.completions({
      messages: enhancedMessages,
      assistant,
      onFilterMessages: async (messages) => {
        console.log('过滤后的消息:调试', messages[messages.length - 1])
        _messages = messages
      },
      onChunk: ({ text, reasoning_content, usage, metrics, search, citations }) => {
        message.content = message.content + text || ''
        message.usage = usage
        message.metrics = metrics

        if (reasoning_content) {
          message.reasoning_content = (message.reasoning_content || '') + reasoning_content
        }

        if (search) {
          message.metadata = { groundingMetadata: search }
        }

        // Handle citations from Perplexity API
        if (isFirstChunk && citations) {
          message.metadata = {
            ...message.metadata,
            citations
          }
          isFirstChunk = false
        }

        onResponse({ ...message, status: 'pending' })
      }
    })

    message.status = 'success'
    console.log('完成响应:调试', message)

    if (!message.usage || !message?.usage?.completion_tokens) {
      console.log('计算消息使用量:调试')
      message.usage = await estimateMessagesUsage({
        assistant,
        messages: [..._messages, message]
      })
    }
  } catch (error: any) {
    console.error('发生错误:调试', error)
    message.status = 'error'
    message.error = formatMessageError(error)
  }

  timer && clearInterval(timer)

  if (paused) {
    console.log('返回暂停状态的消息:调试', message)
    return message
  }

  // Update message status
  message.status = window.keyv.get(EVENT_NAMES.CHAT_COMPLETION_PAUSED) ? 'paused' : message.status

  // Emit chat completion event
  console.log('发送完成事件:调试', message)
  EventEmitter.emit(EVENT_NAMES.RECEIVE_MESSAGE, message)
  onResponse(message)

  // Reset generating state
  store.dispatch(setGenerating(false))

  return message
}

interface FetchTranslateProps {
  message: Message
  assistant: Assistant
  onResponse?: (text: string) => void
}

export async function fetchTranslate({ message, assistant, onResponse }: FetchTranslateProps) {
  const model = getTranslateModel()

  if (!model) {
    return ''
  }

  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.translate(message, assistant, onResponse)
  } catch (error: any) {
    return ''
  }
}

export async function fetchMessagesSummary({ messages, assistant }: { messages: Message[]; assistant: Assistant }) {
  const model = getTopNamingModel() || assistant.model || getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return null
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.summaries(filterMessages(messages), assistant)
  } catch (error: any) {
    return null
  }
}

export async function fetchGenerate({ prompt, content }: { prompt: string; content: string }): Promise<string> {
  const model = getDefaultModel()
  const provider = getProviderByModel(model)

  if (!hasApiKey(provider)) {
    return ''
  }

  const AI = new AiProvider(provider)

  try {
    return await AI.generateText({ prompt, content })
  } catch (error: any) {
    return ''
  }
}

export async function fetchSuggestions({
  messages,
  assistant
}: {
  messages: Message[]
  assistant: Assistant
}): Promise<Suggestion[]> {
  const model = assistant.model

  if (!model) {
    return []
  }

  if (model.owned_by !== 'graphrag') {
    return []
  }

  if (model.id.endsWith('global')) {
    return []
  }

  const provider = getAssistantProvider(assistant)
  const AI = new AiProvider(provider)

  try {
    return await AI.suggestions(filterMessages(messages), assistant)
  } catch (error: any) {
    return []
  }
}

export async function checkApi(provider: Provider, model: Model) {
  const key = 'api-check'
  const style = { marginTop: '3vh' }

  if (provider.id !== 'ollama' && provider.id !== 'lmstudio') {
    if (!provider.apiKey) {
      window.message.error({ content: i18n.t('message.error.enter.api.key'), key, style })
      return {
        valid: false,
        error: new Error(i18n.t('message.error.enter.api.key'))
      }
    }
  }

  if (!provider.apiHost) {
    window.message.error({ content: i18n.t('message.error.enter.api.host'), key, style })
    return {
      valid: false,
      error: new Error('message.error.enter.api.host')
    }
  }

  if (isEmpty(provider.models)) {
    window.message.error({ content: i18n.t('message.error.enter.model'), key, style })
    return {
      valid: false,
      error: new Error('message.error.enter.model')
    }
  }

  const AI = new AiProvider(provider)

  const { valid, error } = await AI.check(model)

  return {
    valid,
    error
  }
}

function hasApiKey(provider: Provider) {
  if (!provider) return false
  if (provider.id === 'ollama' || provider.id === 'lmstudio') return true
  return !isEmpty(provider.apiKey)
}

export async function fetchModels(provider: Provider) {
  const AI = new AiProvider(provider)

  try {
    return await AI.models()
  } catch (error) {
    return []
  }
}
