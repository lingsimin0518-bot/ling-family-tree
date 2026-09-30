INSERT INTO users(id,email,display_name,created_at,username,password_hash,phone,nickname,avatar,status,updated_at,phone_verified_at,wechat_openid,wechat_unionid,system_role,last_login_at,disabled_at,disabled_by) VALUES
('u-super','super@example.test','Super','2026-09-25T00:00:00Z','super','hash-super','13000000001','超级管理员','','ACTIVE','2026-09-25T00:00:00Z',NULL,NULL,NULL,'SUPER_ADMIN',NULL,NULL,NULL),
('u-user','user@example.test','User','2026-09-25T00:00:00Z','user','hash-user','13000000002','普通用户','','ACTIVE','2026-09-25T00:00:00Z',NULL,NULL,NULL,'USER',NULL,NULL,NULL),
('u-owner','owner@example.test','Owner','2026-09-25T00:00:00Z','owner','hash-owner','13000000003','族谱创建者','','ACTIVE','2026-09-25T00:00:00Z',NULL,NULL,NULL,'USER',NULL,NULL,NULL),
('u-admin','admin@example.test','Admin','2026-09-25T00:00:00Z','admin','hash-admin','13000000004','族谱管理员','','ACTIVE','2026-09-25T00:00:00Z',NULL,NULL,NULL,'USER',NULL,NULL,NULL);

INSERT INTO user_sessions(id,user_id,expires_at,created_at,last_seen_at,user_agent) VALUES
('oKhWmcCQEgNfiAmgwYHlzncM3u2HtQhnFs2AnGXWJ1Y=','u-super','2099-01-01T00:00:00Z','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z','test'),
('kkWL/8mxkP7qS/2TYRBgqOdo/zpduEtMOHaC4ppwQ28=','u-user','2099-01-01T00:00:00Z','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z','test'),
('wyx7uX14XGWRbAVTjPwPnZR2jLFn63NhUHF4PMxL73c=','u-owner','2099-01-01T00:00:00Z','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z','test'),
('EKTHyfxSBtbzbcaUSoG7b0o8sOJQFK47EubD5ScSKSo=','u-admin','2099-01-01T00:00:00Z','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z','test');

INSERT INTO families(id,name,description,join_code,source_type,created_by,created_at) VALUES
('f-test','测试族谱','backup test','TEST0001','DATABASE','u-owner','2026-09-25T00:00:00Z'),
('f-legacy','历史测试族谱','backup test','LINGSHI','LEGACY_STATIC','u-super','2026-09-25T00:00:00Z');
INSERT INTO family_users(user_id,family_id,role,joined_at) VALUES('u-owner','f-test','OWNER','2026-09-25T00:00:00Z'),('u-admin','f-test','ADMIN','2026-09-25T00:00:00Z');
INSERT INTO generations(id,family_id,number,title) VALUES('g1','f-test',1,'第一代');
INSERT INTO persons(id,family_id,linked_user_id,name,gender,generation,birth_year,biography,created_at,created_by_user_id,updated_by_user_id,updated_at) VALUES('p1','f-test','u-owner','测试甲','男',1,'1900','测试','2026-09-25T00:00:00Z','u-owner','u-owner','2026-09-25T00:00:00Z'),('p2','f-test',NULL,'测试乙','女',2,'1930','测试','2026-09-25T00:00:00Z','u-owner',NULL,NULL);
INSERT INTO relationships(id,family_id,from_person_id,to_person_id,type,created_at,created_by_user_id) VALUES('r1','f-test','p1','p2','PARENT','2026-09-25T00:00:00Z','u-owner');
INSERT INTO announcements(id,family_id,author_user_id,title,body,created_at) VALUES('a1','f-test','u-owner','测试公告','备份验证','2026-09-25T00:00:00Z');
INSERT INTO media(id,family_id,person_id,uploader_user_id,kind,storage_key,created_at) VALUES('m1','f-test','p1','u-owner','PHOTO','test-key','2026-09-25T00:00:00Z');
INSERT INTO person_claims(id,family_id,user_id,person_id,status,created_at) VALUES('c1','f-test','u-owner','p1','APPROVED','2026-09-25T00:00:00Z');
INSERT INTO system_audit_logs(id,operator_user_id,action_type,target_user_id,old_value,new_value,created_at,reason) VALUES('l1','u-super','TEST','u-user','','','2026-09-25T00:00:00Z','backup test');
INSERT INTO action_rate_limit(id,actor_key,user_id,family_id,family_key,action_type,target_id,last_success_at) VALUES('rl1','u:u-owner','u-owner','f-test','f-test','CREATE_PERSON','p2','2026-09-25T00:00:00Z');
INSERT INTO action_idempotency(id,actor_key,family_key,action_type,idempotency_key,status,response_json,created_at,completed_at) VALUES('i1','u:u-owner','f-test','CREATE_PERSON','key1','COMPLETED','{}','2026-09-25T00:00:00Z','2026-09-25T00:00:00Z');
INSERT INTO family_activities(id,family_id,author_user_id,title,body,status,reviewer_user_id,created_at,reviewed_at) VALUES('fa1','f-test','u-user','测试动态','备份验证','APPROVED','u-admin','2026-09-25T00:00:00Z','2026-09-25T01:00:00Z');
INSERT INTO review_requests(id,family_id,applicant_user_id,reviewer_user_id,request_type,target_id,old_data,new_data,reason,status,created_at,reviewed_at) VALUES('rr1','f-test','u-user','u-admin','FAMILY_ACTIVITY','fa1',NULL,'{"title":"测试动态"}','测试','APPROVED','2026-09-25T00:00:00Z','2026-09-25T01:00:00Z');
INSERT INTO user_messages(id,user_id,family_id,message_type,title,content,related_request_id,is_read,created_at) VALUES('um1','u-user','f-test','REVIEW_APPROVED','申请已通过','测试消息','rr1',0,'2026-09-25T01:00:00Z');
