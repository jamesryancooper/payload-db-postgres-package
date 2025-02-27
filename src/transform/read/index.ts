/* eslint-disable no-param-reassign */
import type { Field, TypeWithID } from 'payload'
import type { SanitizedConfig } from 'payload'

import type { PostgresAdapter } from '../../types.js'

import { createBlocksMap } from '../../utilities/createBlocksMap.js'
import { createPathMap } from '../../utilities/createRelationshipMap.js'
import { traverseFields } from './traverseFields.js'

type TransformArgs = {
  adapter: PostgresAdapter
  config: SanitizedConfig
  data: Record<string, unknown>
  fallbackLocale?: false | string
  fields: Field[]
  locale?: string
}

// This is the entry point to transform Drizzle output data
// into the shape Payload expects based on field schema
export const transform = <T extends TypeWithID>({
  adapter,
  config,
  data,
  fields,
}: TransformArgs): T => {
  let relationships: Record<string, Record<string, unknown>[]> = {}
  let texts: Record<string, Record<string, unknown>[]> = {}
  let numbers: Record<string, Record<string, unknown>[]> = {}

  if ('_rels' in data) {
    relationships = createPathMap(data._rels)
    delete data._rels
  }

  if ('_texts' in data) {
    texts = createPathMap(data._texts)
    delete data._texts
  }

  if ('_numbers' in data) {
    numbers = createPathMap(data._numbers)
    delete data._numbers
  }

  const blocks = createBlocksMap(data)
  const deletions = []

  const result = traverseFields<T>({
    adapter,
    blocks,
    config,
    dataRef: {
      id: data.id,
    },
    deletions,
    fieldPrefix: '',
    fields,
    numbers,
    path: '',
    relationships,
    table: data,
    texts,
  })

  deletions.forEach((deletion) => deletion())

  return result
}
