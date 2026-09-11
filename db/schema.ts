import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id:text('id').primaryKey(),
  username:text('username'),
  passwordHash:text('password_hash'),
  email:text('email'),
  phone:text('phone'),
  phoneVerifiedAt:text('phone_verified_at'),
  nickname:text('nickname'),
  avatar:text('avatar'),
  wechatOpenid:text('wechat_openid'),
  wechatUnionid:text('wechat_unionid'),
  status:text('status').notNull().default('ACTIVE'),
  displayName:text('display_name'),
  createdAt:text('created_at').notNull(),
  updatedAt:text('updated_at'),
}, t=>[
  uniqueIndex('idx_users_username_unique').on(t.username),
  uniqueIndex('idx_users_email_unique').on(t.email),
  uniqueIndex('idx_users_phone_unique').on(t.phone),
  uniqueIndex('idx_users_wechat_openid_unique').on(t.wechatOpenid),
  uniqueIndex('idx_users_wechat_unionid_unique').on(t.wechatUnionid),
]);
export const userSessions = sqliteTable('user_sessions', {
  id:text('id').primaryKey(),
  userId:text('user_id').notNull().references(()=>users.id,{onDelete:'cascade'}),
  expiresAt:text('expires_at').notNull(),
  createdAt:text('created_at').notNull(),
  lastSeenAt:text('last_seen_at').notNull(),
  userAgent:text('user_agent'),
}, t=>[
  index('idx_user_sessions_user').on(t.userId),
  index('idx_user_sessions_expires').on(t.expiresAt),
]);
export const families = sqliteTable('families', { id:text('id').primaryKey(), name:text('name').notNull(), description:text('description'), joinCode:text('join_code').notNull(), sourceType:text('source_type',{enum:['DATABASE','LEGACY_STATIC']}).notNull().default('DATABASE'), createdBy:text('created_by').notNull(), createdAt:text('created_at').notNull() }, t=>[uniqueIndex('idx_families_join_code').on(t.joinCode)]);
export const familyUsers = sqliteTable('family_users', { userId:text('user_id').notNull().references(()=>users.id), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), role:text('role',{enum:['OWNER','ADMIN','EDITOR','VIEWER']}).notNull(), joinedAt:text('joined_at').notNull() }, t=>[primaryKey({columns:[t.userId,t.familyId]}),index('idx_family_users_family_role').on(t.familyId,t.role)]);
export const generations = sqliteTable('generations', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), number:integer('number').notNull(), title:text('title') }, t=>[uniqueIndex('idx_generations_family_number').on(t.familyId,t.number)]);
export const persons = sqliteTable('persons', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), linkedUserId:text('linked_user_id').references(()=>users.id), name:text('name').notNull(), gender:text('gender'), generation:integer('generation').notNull(), birthYear:text('birth_year'), biography:text('biography'), createdAt:text('created_at').notNull() }, t=>[index('idx_persons_family_generation').on(t.familyId,t.generation),index('idx_persons_family_name').on(t.familyId,t.name)]);
export const relationships = sqliteTable('relationships', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), fromPersonId:text('from_person_id').notNull().references(()=>persons.id,{onDelete:'cascade'}), toPersonId:text('to_person_id').notNull().references(()=>persons.id,{onDelete:'cascade'}), type:text('type',{enum:['PARENT','CHILD','SPOUSE']}).notNull(), createdAt:text('created_at').notNull() }, t=>[index('idx_relationships_family_from').on(t.familyId,t.fromPersonId),index('idx_relationships_family_to').on(t.familyId,t.toPersonId)]);
export const announcements = sqliteTable('announcements', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), authorUserId:text('author_user_id').notNull().references(()=>users.id), title:text('title').notNull(), body:text('body').notNull(), createdAt:text('created_at').notNull() }, t=>[index('idx_announcements_family_created').on(t.familyId,t.createdAt)]);
export const media = sqliteTable('media', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), personId:text('person_id').references(()=>persons.id,{onDelete:'cascade'}), uploaderUserId:text('uploader_user_id').notNull().references(()=>users.id), kind:text('kind').notNull(), storageKey:text('storage_key').notNull(), createdAt:text('created_at').notNull() }, t=>[index('idx_media_family_person').on(t.familyId,t.personId)]);
export const personClaims = sqliteTable('person_claims', { id:text('id').primaryKey(), familyId:text('family_id').notNull().references(()=>families.id,{onDelete:'cascade'}), userId:text('user_id').notNull().references(()=>users.id), personId:text('person_id').notNull().references(()=>persons.id,{onDelete:'cascade'}), status:text('status',{enum:['PENDING','APPROVED','REJECTED']}).notNull(), createdAt:text('created_at').notNull() }, t=>[uniqueIndex('idx_claims_family_user_person').on(t.familyId,t.userId,t.personId)]);
