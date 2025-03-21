import { CommentOutlined, EnterOutlined, SearchOutlined } from '@ant-design/icons'
import db from '@renderer/databases'
import { EventEmitter } from '@renderer/services/EventService'
import { useAppSelector } from '@renderer/store'
import { Topic } from '@renderer/types'
import { Button, Dropdown, Input, Tooltip } from 'antd'
import { FC, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { createGlobalStyle } from 'styled-components'

interface Props {
  onMentionTopic: (topic: Topic) => void
  ToolbarButton: typeof Button
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * 处理话题引用的工具函数
 * 将话题引用格式 [[topicName]|[topicId]] 转换为实际的历史记录
 * @param content - 包含话题引用的原始内容
 * @returns 处理后的内容，包含话题历史记录
 */
export const processTopicReferences = async (content: string): Promise<string> => {
  let processedContent = content
  const topicRefs = content.match(/\[\[([^\]|]+)\]\|\[([^\]|]+)\]\]/g)

  if (topicRefs) {
    for (const ref of topicRefs) {
      const [, topicName, topicId] = ref.match(/\[\[([^\]|]+)\]\|\[([^\]|]+)\]\]/) || []
      if (topicName && topicId) {
        try {
          const topicMessages = await db.topics.get(topicId).then((topic) => topic?.messages || [])

          if (topicMessages.length > 0) {
            const historyContext = topicMessages.map((msg) => ({
              role: msg.role,
              content: msg.content
            }))

            processedContent = processedContent.replace(
              ref,
              `[引用话题: ${topicName}]\n${JSON.stringify(historyContext)}`
            )
          }
        } catch (error) {
          console.error('获取话题历史失败:', error)
        }
      }
    }
  }

  return processedContent
}

/**
 * 格式化话题显示
 * 将 [[topicName]|[topicId]] 格式转换为 [topicName] 格式
 */
export const formatTopicDisplay = (text: string): string => {
  return text.replace(/\[\[([^\]|]+)\]\|\[([^\]|]+)\]\]/g, '[$1]')
}

/**
 * 话题提及按钮组件
 * 用于显示和选择可引用的话题列表
 *
 * @prop onMentionTopic - 外部回调函数，当话题被选中时触发
 * @prop ToolbarButton - 按钮组件
 * @prop isOpen - 控制下拉菜单是否打开
 * @prop onOpenChange - 下拉菜单状态改变时的回调
 */
const MentionTopicsButton: FC<Props> = ({ onMentionTopic, ToolbarButton, isOpen, onOpenChange }) => {
  const { t } = useTranslation()
  const dropdownRef = useRef<any>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searchText, setSearchText] = useState('')
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const [menuDismissed, setMenuDismissed] = useState(false) // 新增状态，追踪菜单是否被手动关闭

  // 从 Redux store 获取所有助手及其话题
  const assistants = useAppSelector((state) => state.assistants.assistants)

  /**
   * 对话题进行过滤和排序
   * 排序规则：1. 有提示词的排在前面 2. 名字长的排在前面
   */
  const filteredTopics = assistants.reduce(
    (acc, assistant) => {
      if (assistant.topics && assistant.topics.length > 0) {
        // 先按搜索文本过滤
        let filteredAssistantTopics = assistant.topics
        if (searchText) {
          filteredAssistantTopics = assistant.topics.filter((topic) =>
            topic.name?.toLowerCase().includes(searchText.toLowerCase())
          )
        }

        // 如果过滤后还有话题，则进行排序
        if (filteredAssistantTopics.length > 0) {
          const sortedTopics = [...filteredAssistantTopics].sort((a, b) => {
            if (!!a.prompt !== !!b.prompt) {
              return a.prompt ? -1 : 1
            }
            return (b.name?.length || 0) - (a.name?.length || 0)
          })

          acc.push({
            assistant,
            topics: sortedTopics
          })
        }
      }
      return acc
    },
    [] as { assistant: (typeof assistants)[0]; topics: Topic[] }[]
  )

  // 所有可见话题的扁平列表，用于键盘导航
  const allVisibleTopics = filteredTopics.reduce((acc, group) => [...acc, ...group.topics], [] as Topic[])

  /**
   * 处理话题选择
   * 选中话题后会触发外部回调并关闭下拉菜单
   */
  const handleTopicSelect = (topic: Topic) => {
    onMentionTopic(topic) // 向父组件传递选中的话题
    onOpenChange(false) // 关闭下拉菜单
    setSelectedIndex(0) // 重置选中索引
    setMenuDismissed(false) // 重置菜单关闭状态

    // 发射一个事件表示刚刚选择了主题
    EventEmitter.emit(EVENT_NAMES.TOPIC_JUST_SELECTED)
  }

  /**
   * 键盘导航处理
   * 支持上下键选择和回车确认
   */
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isOpen || allVisibleTopics.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % allVisibleTopics.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + allVisibleTopics.length) % allVisibleTopics.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selectedTopic = allVisibleTopics[selectedIndex]
      if (selectedTopic) {
        handleTopicSelect(selectedTopic)
        // 在这里也发射事件
        EventEmitter.emit(EVENT_NAMES.TOPIC_JUST_SELECTED)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
      setMenuDismissed(true)
    }
  }

  // 添加和移除键盘事件监听器
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, allVisibleTopics])

  // 当菜单打开时重置选中索引
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0)
    }
  }, [isOpen])

  // 监听话题筛选事件
  useEffect(() => {
    const handleFilterTopics = (text: string) => {
      setSearchText(text)
      if (!isOpen && !menuDismissed) {
        // 只有在菜单未被手动关闭时才自动打开
        onOpenChange(true)
      }
    }

    const EVENT_NAMES = {
      FILTER_TOPICS: 'filter-topics',
      SHOW_TOPIC_SELECTOR: 'show-topic-selector'
    }

    // 监听话题筛选事件
    window.addEventListener(EVENT_NAMES.FILTER_TOPICS, handleFilterTopics as EventListener)

    // 监听显示话题选择器事件
    const showTopicSelector = () => {
      setSearchText('') // 清空搜索文本
      setMenuDismissed(false) // 重置菜单关闭状态
      onOpenChange(true) // 打开菜单
    }
    window.addEventListener(EVENT_NAMES.SHOW_TOPIC_SELECTOR, showTopicSelector)

    return () => {
      window.removeEventListener(EVENT_NAMES.FILTER_TOPICS, handleFilterTopics as EventListener)
      window.removeEventListener(EVENT_NAMES.SHOW_TOPIC_SELECTOR, showTopicSelector)
    }
  }, [isOpen, onOpenChange, menuDismissed])

  useLayoutEffect(() => {
    if (isOpen && selectedIndex > -1 && itemRefs.current[selectedIndex]) {
      requestAnimationFrame(() => {
        itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }
  }, [isOpen, selectedIndex])

  const menu = (
    <MenuContainer ref={menuRef} className="ant-dropdown-menu">
      <SearchContainer>
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--color-text-3)' }} />}
          placeholder={t('chat.topics.search_placeholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          allowClear
        />
      </SearchContainer>
      {filteredTopics.length > 0 ? (
        filteredTopics.map(({ assistant, topics }) => (
          <AssistantGroup key={assistant.id}>
            <AssistantName>{assistant.name || t('chat.assistant.untitled')}</AssistantName>
            <TopicList>
              {topics.map((topic) => {
                const topicIndex = allVisibleTopics.findIndex((t) => t.id === topic.id)
                return (
                  <TopicItem
                    key={topic.id}
                    ref={(el) => {
                      if (el) {
                        itemRefs.current[topicIndex] = el
                      }
                    }}
                    className={`ant-dropdown-menu-item ${topicIndex === selectedIndex ? 'selected' : ''}`}
                    onClick={() => handleTopicSelect(topic)}>
                    <TopicNameRow>
                      <TopicTitle>{topic.name || t('chat.topics.untitled')}</TopicTitle>
                      <TopicPrompt>{topic.prompt || t('chat.topics.no_messages')}</TopicPrompt>
                      <Tooltip title={t('chat.topics.view_more')} placement="left">
                        <EnterIcon />
                      </Tooltip>
                    </TopicNameRow>
                  </TopicItem>
                )
              })}
            </TopicList>
          </AssistantGroup>
        ))
      ) : (
        <NoResults>{searchText ? t('chat.topics.no_search_results') : t('chat.topics.no_topics')}</NoResults>
      )}
    </MenuContainer>
  )

  return (
    <>
      <DropdownMenuStyle />
      <Dropdown
        dropdownRender={() => menu}
        trigger={['click']}
        open={isOpen}
        onOpenChange={(open) => {
          onOpenChange(open)
          if (!open) {
            setMenuDismissed(true)
          }
        }}
        overlayClassName="mention-topics-dropdown">
        <Tooltip placement="top" title={t('chat.topics.select')} arrow>
          <ToolbarButton type="text" ref={dropdownRef}>
            <CommentOutlined />
          </ToolbarButton>
        </Tooltip>
      </Dropdown>
    </>
  )
}

const MenuContainer = styled.div`
  max-height: 300px;
  overflow-y: auto;
  padding: 8px;
  background-color: var(--color-background);
  border-radius: 20px;
  width: 450px;
`

const AssistantGroup = styled.div`
  margin-bottom: 12px;
  background-color: var(--color-background);
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 8px;

  &:last-child {
    margin-bottom: 0;
    border-bottom: none;
    padding-bottom: 0;
  }
`

const AssistantName = styled.div`
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-3);
  padding: 4px 8px;
  margin-bottom: 2px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`

const TopicList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const TopicItem = styled.div`
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: flex-start;
  position: relative;

  &:hover {
    background: var(--color-background-mute);
  }

  &.selected {
    background: var(--color-primary-mute);
    color: var(--color-primary);
  }
`

const TopicTitle = styled.span`
  font-size: 13px;
  color: var(--color-text-1);
  width: 35%;
  padding-right: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
  line-height: 1.4;

  .selected & {
    color: var(--color-primary);
  }
`

const TopicPrompt = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  width: 65%;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: break-all;
  line-height: 1.3;

  .selected & {
    color: var(--color-primary);
    opacity: 0.8;
  }
`

const TopicNameRow = styled.div`
  display: flex;
  align-items: flex-start;
  width: 100%;
  position: relative;
`

const EnterIcon = styled(EnterOutlined)`
  position: absolute;
  right: 2px;
  bottom: 2px;
  font-size: 11px;
  color: var(--color-text-3);
  opacity: 0.5;

  .selected & {
    color: var(--color-primary);
    opacity: 0.8;
  }

  ${TopicItem}:hover & {
    opacity: 0.8;
  }
`

const NoResults = styled.div`
  padding: 8px;
  text-align: center;
  color: var(--color-text-3);
  font-size: 12px;
`

const DropdownMenuStyle = createGlobalStyle`
  .mention-topics-dropdown {
    .ant-dropdown-menu {
      max-height: 300px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px;
      margin-bottom: 40px;
      position: relative;
      border-radius: 8px;
      background-color: var(--color-background);
      box-shadow: 0 6px 16px 0 rgba(0, 0, 0, 0.08),
                  0 3px 6px -4px rgba(0, 0, 0, 0.12),
                  0 9px 28px 8px rgba(0, 0, 0, 0.05);

      &::-webkit-scrollbar {
        width: 4px;
        height: 4px;
      }

      &::-webkit-scrollbar-thumb {
        border-radius: 10px;
        background: var(--color-scrollbar-thumb);

        &:hover {
          background: var(--color-scrollbar-thumb-hover);
        }
      }

      &::-webkit-scrollbar-track {
        background: transparent;
      }
    }
  }
`

const SearchContainer = styled.div`
  padding: 0 8px 8px 8px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 8px;

  .ant-input-affix-wrapper {
    border-radius: 6px;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);

    &:hover,
    &:focus-within {
      border-color: var(--color-primary);
      box-shadow: none;
    }

    input {
      background-color: transparent;
      color: var(--color-text);
    }
  }
`

export default MentionTopicsButton
