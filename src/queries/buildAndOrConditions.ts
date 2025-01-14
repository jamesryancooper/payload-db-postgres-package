import type { SQL } from 'drizzle-orm'
import type { Field, Where } from 'payload'

import type { GenericColumn, PostgresAdapter } from '../types.js'
import type { BuildQueryJoinAliases } from './buildQuery.js'

import { parseParams } from './parseParams.js'

export async function buildAndOrConditions({
  adapter,
  fields,
  joins,
  locale,
  selectFields,
  tableName,
  where,
}: {
  adapter: PostgresAdapter
  collectionSlug?: string
  fields: Field[]
  globalSlug?: string
  joins: BuildQueryJoinAliases
  locale?: string
  selectFields: Record<string, GenericColumn>
  tableName: string
  where: Where[]
}): Promise<SQL[]> {
  const completedConditions = []
  // Loop over all AND / OR operations and add them to the AND / OR query param
  // Operations should come through as an array
  // eslint-disable-next-line no-restricted-syntax
  for (const condition of where) {
    // If the operation is properly formatted as an object
    if (typeof condition === 'object') {
      // eslint-disable-next-line no-await-in-loop
      const result = await parseParams({
        adapter,
        fields,
        joins,
        locale,
        selectFields,
        tableName,
        where: condition,
      })
      if (result && Object.keys(result).length > 0) {
        completedConditions.push(result)
      }
    }
  }
  return completedConditions
}
