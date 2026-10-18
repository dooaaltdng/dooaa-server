CREATE TYPE "public"."account_status" AS ENUM('active', 'review', 'suspended', 'banned', 'closed');--> statement-breakpoint
CREATE TYPE "public"."checkout_method" AS ENUM('card', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."delivery_type" AS ENUM('meetup', 'local', 'nationwide', 'digital');--> statement-breakpoint
CREATE TYPE "public"."dispute_outcome" AS ENUM('refunded', 'released', 'evidence-requested', 'closed');--> statement-breakpoint
CREATE TYPE "public"."dispute_party" AS ENUM('buyer', 'seller');--> statement-breakpoint
CREATE TYPE "public"."dispute_state" AS ENUM('active', 'pending', 'completed');--> statement-breakpoint
CREATE TYPE "public"."earning_status" AS ENUM('pending', 'available', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."escrow_phase" AS ENUM('funded', 'shipped', 'inspection', 'disputed', 'released', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."escrow_status" AS ENUM('pending', 'dispute', 'completed');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'prefer-not-to-say');--> statement-breakpoint
CREATE TYPE "public"."id_type" AS ENUM('drivers-license', 'passport', 'national-id');--> statement-breakpoint
CREATE TYPE "public"."identity_status" AS ENUM('unverified', 'pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."listed_as" AS ENUM('seller', 'official', 'admin');--> statement-breakpoint
CREATE TYPE "public"."listing_payment_method" AS ENUM('escrow', 'default');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'pending', 'active', 'inactive', 'suspicious', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'file');--> statement-breakpoint
CREATE TYPE "public"."media_purpose" AS ENUM('product', 'avatar', 'kyc', 'message', 'evidence', 'support', 'meetup', 'shipment', 'content');--> statement-breakpoint
CREATE TYPE "public"."media_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'image', 'video', 'file', 'product', 'meetup', 'system', 'dispute', 'admin');--> statement-breakpoint
CREATE TYPE "public"."notification_tone" AS ENUM('blue', 'green', 'red');--> statement-breakpoint
CREATE TYPE "public"."oauth_provider" AS ENUM('google', 'facebook');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('pending', 'accepted', 'declined', 'countered', 'withdrawn', 'used');--> statement-breakpoint
CREATE TYPE "public"."order_actor" AS ENUM('buyer', 'seller', 'system', 'staff');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('standard', 'escrow');--> statement-breakpoint
CREATE TYPE "public"."order_payment_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting-payment', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."otp_channel" AS ENUM('email', 'sms', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('verify-email', 'reset-password', 'change-password', 'confirm-release', 'verify-phone');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."payout_account_source" AS ENUM('settings', 'verification');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pricing_type" AS ENUM('fixed', 'negotiable');--> statement-breakpoint
CREATE TYPE "public"."product_condition" AS ENUM('new', 'slightly-used', 'used', 'refurbished');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sender_role" AS ENUM('buyer', 'seller', 'staff', 'system');--> statement-breakpoint
CREATE TYPE "public"."settlement" AS ENUM('released', 'refunded', 'reversed', 'force-released');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('superadmin', 'admin', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."stat_scope" AS ENUM('site', 'seller');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('user', 'staff');--> statement-breakpoint
CREATE TYPE "public"."support_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('buyer', 'seller');--> statement-breakpoint
CREATE TYPE "public"."verification_level" AS ENUM('normal', 'high-value');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE SEQUENCE "public"."dispute_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 3601 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."support_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1001 CACHE 1;--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"is_new_user" boolean DEFAULT false NOT NULL,
	"next" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"channel" "otp_channel" NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" "staff_role" NOT NULL,
	"title" text,
	"avatar_url" text,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_by" uuid,
	"last_login_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"failed_sign_ins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_email_lowercase" CHECK ("staff"."email" = lower("staff"."email"))
);
--> statement-breakpoint
CREATE TABLE "user_oauth_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "oauth_provider" NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role",
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"identity" "identity_status" DEFAULT 'unverified' NOT NULL,
	"verification_level" "verification_level" DEFAULT 'normal' NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"avatar_url" text,
	"gender" "gender",
	"location" text,
	"region" text,
	"seller_store_name" text,
	"seller_dispatch_days" integer DEFAULT 3 NOT NULL,
	"seller_response_label" text DEFAULT 'Typically responds within a few hours' NOT NULL,
	"seller_delivery_label" text DEFAULT 'Nationwide Delivery (1-3 business days within Lagos)' NOT NULL,
	"seller_listing_limit" integer,
	"stats_purchases" integer DEFAULT 0 NOT NULL,
	"stats_active_listings" integer DEFAULT 0 NOT NULL,
	"stats_sales" integer DEFAULT 0 NOT NULL,
	"stats_rating_average" double precision DEFAULT 0 NOT NULL,
	"stats_rating_count" integer DEFAULT 0 NOT NULL,
	"notification_prefs" jsonb DEFAULT '{"email":true,"deals":true,"sms":false,"messages":true,"feedback":false,"web":true}'::jsonb NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_sign_ins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"privacy_accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"close_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_seller_dispatch_days_range" CHECK ("users"."seller_dispatch_days" between 1 and 30),
	CONSTRAINT "users_seller_listing_limit_nonnegative" CHECK ("users"."seller_listing_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"actor_role" text,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"elevated" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"home" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_pages_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"author_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"scope" "stat_scope" NOT NULL,
	"seller_id" uuid,
	"visits" integer DEFAULT 0 NOT NULL,
	"product_views" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_stats_scope_seller_day_key" UNIQUE NULLS NOT DISTINCT("scope","seller_id","day")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_type" "subject_type" NOT NULL,
	"purpose" "media_purpose" NOT NULL,
	"kind" "media_kind" NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"visibility" "media_visibility" NOT NULL,
	"storage_key" text NOT NULL,
	"url" text,
	"poster_url" text,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_type" "subject_type" NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tone" "notification_tone" DEFAULT 'blue' NOT NULL,
	"link" text,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"order_reference" text,
	"topic" text NOT NULL,
	"detail" text NOT NULL,
	"attachments" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "support_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_days" (
	"visitor_id" text NOT NULL,
	"day" date NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_days_visitor_id_day_pk" PRIMARY KEY("visitor_id","day")
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_user_id_product_id_pk" PRIMARY KEY("user_id","product_id"),
	CONSTRAINT "cart_items_quantity_positive" CHECK ("cart_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"coupon_code" text,
	"delivery" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" "coupon_type" NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"max_discount" numeric(14, 2),
	"min_subtotal" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_uppercase" CHECK ("coupons"."code" = upper("coupons"."code")),
	CONSTRAINT "coupons_value_nonnegative" CHECK ("coupons"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"highlights" text[] DEFAULT '{}'::text[] NOT NULL,
	"category_id" text NOT NULL,
	"brand" text,
	"condition" "product_condition" NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"previous_price" numeric(14, 2),
	"price_changed_at" timestamp with time zone,
	"previous_price_since" timestamp with time zone,
	"pricing" "pricing_type" DEFAULT 'fixed' NOT NULL,
	"payment_method" "listing_payment_method" DEFAULT 'escrow' NOT NULL,
	"delivery" "delivery_type" DEFAULT 'nationwide' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"location" text DEFAULT 'Lagos' NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"videos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"moderation_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"moderation_note" text,
	"moderation_reviewed_by" uuid,
	"moderation_reviewed_at" timestamp with time zone,
	"listed_as" "listed_as" DEFAULT 'seller' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"seller_verified" boolean DEFAULT false NOT NULL,
	"stats_views" integer DEFAULT 0 NOT NULL,
	"stats_inquiries" integer DEFAULT 0 NOT NULL,
	"stats_wishlists" integer DEFAULT 0 NOT NULL,
	"stats_units_sold" integer DEFAULT 0 NOT NULL,
	"stats_revenue" numeric(16, 2) DEFAULT 0 NOT NULL,
	"stats_last_sale_at" timestamp with time zone,
	"stats_rating_average" double precision DEFAULT 0 NOT NULL,
	"stats_rating_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(brand, '')), 'B') || setweight(to_tsvector('english', coalesce(summary, '')), 'C') || setweight(to_tsvector('english', coalesce(location, '') || ' ' || coalesce(description, '')), 'D')) STORED NOT NULL,
	CONSTRAINT "products_price_nonnegative" CHECK ("products"."price" >= 0),
	CONSTRAINT "products_stock_nonnegative" CHECK ("products"."stock" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"restock_alert" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"product_id" uuid,
	"subject" jsonb,
	"order_id" uuid,
	"dispute_id" uuid,
	"last_message_preview" text DEFAULT '' NOT NULL,
	"last_message_kind" "message_kind",
	"last_message_at" timestamp with time zone,
	"last_message_sender_id" uuid,
	"buyer_unread" integer DEFAULT 0 NOT NULL,
	"seller_unread" integer DEFAULT 0 NOT NULL,
	"buyer_read_at" timestamp with time zone,
	"seller_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"order_id" uuid NOT NULL,
	"conversation_id" uuid,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"item" text NOT NULL,
	"order_value" numeric(14, 2) NOT NULL,
	"order_number" text NOT NULL,
	"purchase_date" timestamp with time zone NOT NULL,
	"state" "dispute_state" DEFAULT 'active' NOT NULL,
	"outcome" "dispute_outcome",
	"opened_by" "dispute_party" DEFAULT 'buyer' NOT NULL,
	"reason" text NOT NULL,
	"seller_claim" text,
	"evidence" text[] DEFAULT '{}'::text[] NOT NULL,
	"seller_evidence" text[] DEFAULT '{}'::text[] NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid,
	"sender_role" "sender_role" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"system_lead" text,
	"media" jsonb,
	"product" jsonb,
	"offer_id" uuid,
	"meetup" jsonb,
	"dispute" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"listed" numeric(14, 2) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" "offer_status" DEFAULT 'pending' NOT NULL,
	"counter" jsonb,
	"agreed_amount" numeric(14, 2),
	"responded_at" timestamp with time zone,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"condition" "product_condition",
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"checkout_id" text NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"kind" "order_kind" NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"tax_rate" numeric(6, 3) DEFAULT 0 NOT NULL,
	"tax" numeric(14, 2) DEFAULT 0 NOT NULL,
	"shipping" numeric(14, 2) DEFAULT 0 NOT NULL,
	"escrow_fee" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"commission" numeric(14, 2) DEFAULT 0 NOT NULL,
	"seller_earning" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'NGN' NOT NULL,
	"coupon_code" text,
	"delivery" jsonb NOT NULL,
	"payment_method" "checkout_method" NOT NULL,
	"payment_reference" text,
	"payment_provider" text,
	"payment_status" "order_payment_status" DEFAULT 'pending' NOT NULL,
	"payment_paid_at" timestamp with time zone,
	"payment_brand" text,
	"payment_last4" text,
	"payment_channel" text,
	"status" "order_status" DEFAULT 'awaiting-payment' NOT NULL,
	"escrow_reference" text,
	"escrow_phase" "escrow_phase",
	"escrow_status" "escrow_status",
	"escrow_settlement" "settlement",
	"escrow_phase_before_dispute" "escrow_phase",
	"escrow_funded_at" timestamp with time zone,
	"escrow_shipped_at" timestamp with time zone,
	"escrow_received_at" timestamp with time zone,
	"escrow_inspection_ends_at" timestamp with time zone,
	"escrow_disputed_at" timestamp with time zone,
	"escrow_released_at" timestamp with time zone,
	"escrow_refunded_at" timestamp with time zone,
	"escrow_settled_by" text,
	"escrow_settled_at" timestamp with time zone,
	"escrow_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ship_by" timestamp with time zone,
	"shipment_carrier" text,
	"shipment_tracking_number" text,
	"shipment_proof_url" text,
	"shipment_note" text,
	"shipped_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"return_by" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancelled_by" "order_actor",
	"cancellation_request_reason" text,
	"cancellation_requested_at" timestamp with time zone,
	"refund_status" "refund_status",
	"refund_amount" numeric(14, 2),
	"refund_reference" text,
	"refund_requested_at" timestamp with time zone,
	"refund_processed_at" timestamp with time zone,
	"refund_failure_reason" text,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conversation_id" uuid,
	"offer_id" uuid,
	"dispute_id" uuid,
	"review_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"aspects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"response" jsonb,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "earnings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"product" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"status" "earning_status" DEFAULT 'pending' NOT NULL,
	"funded_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	CONSTRAINT "payment_orders_payment_id_order_id_pk" PRIMARY KEY("payment_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"refund_reference" text NOT NULL,
	"order_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"provider_refund_id" text,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("payment_refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"buyer_id" uuid NOT NULL,
	"checkout_id" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'NGN' NOT NULL,
	"method" "checkout_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"checkout_url" text,
	"paid_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"fulfilling_at" timestamp with time zone,
	"channel" text,
	"gateway_response" text,
	"provider_transaction_id" text,
	"failure_reason" text,
	"reported_amount" numeric(14, 2),
	"card_last4" text,
	"card_brand" text,
	"card_bank" text,
	"card_exp_month" text,
	"card_exp_year" text,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payout_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"bank_code" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"last4" text NOT NULL,
	"fingerprint" text NOT NULL,
	"recipient_code" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"source" "payout_account_source" DEFAULT 'settings' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seller_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"destination" jsonb NOT NULL,
	"status" "payout_status" DEFAULT 'processing' NOT NULL,
	"transfer_code" text,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"automatic" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"seller_id" uuid PRIMARY KEY NOT NULL,
	"available_kobo" bigint DEFAULT 0 NOT NULL,
	"pending_kobo" bigint DEFAULT 0 NOT NULL,
	"withdrawn_kobo" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_available_nonnegative" CHECK ("wallets"."available_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"id_type" "id_type" NOT NULL,
	"documents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"liveness_passed" boolean NOT NULL,
	"bank" jsonb,
	"consents" boolean[] DEFAULT '{}'::boolean[] NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otps" ADD CONSTRAINT "otps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_invited_by_staff_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_oauth_identities" ADD CONSTRAINT "user_oauth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_slug_content_pages_slug_fk" FOREIGN KEY ("slug") REFERENCES "public"."content_pages"("slug") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_carts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."carts"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_slug_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("slug") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_moderation_reviewed_by_staff_id_fk" FOREIGN KEY ("moderation_reviewed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_reviewed_by_staff_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grants_code_hash_key" ON "oauth_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_grants_expires_at_idx" ON "oauth_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "otps_lookup_idx" ON "otps" USING btree ("key","purpose","context","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "otps_expires_at_idx" ON "otps" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_subject_idx" ON "sessions" USING btree ("subject_id","subject_type");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_email_key" ON "staff" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_token_hash_key" ON "staff" USING btree ("invite_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_oauth_identities_provider_subject_key" ON "user_oauth_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "user_oauth_identities_user_idx" ON "user_oauth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_status_created_idx" ON "users" USING btree ("role","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "users_identity_idx" ON "users" USING btree ("identity");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "categories_active_order_idx" ON "categories" USING btree ("active","sort_order");--> statement-breakpoint
CREATE INDEX "content_versions_slug_idx" ON "content_versions" USING btree ("slug","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "media_storage_key_key" ON "media" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_url_idx" ON "media" USING btree ("url");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","recipient_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_reference_key" ON "support_tickets" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "visitor_days_at_idx" ON "visitor_days" USING btree ("at");--> statement-breakpoint
CREATE INDEX "cart_items_product_idx" ON "cart_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "products_public_category_idx" ON "products" USING btree ("category_id","created_at" DESC NULLS LAST) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_public_price_idx" ON "products" USING btree ("price") WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_public_units_sold_idx" ON "products" USING btree ("stats_units_sold" DESC NULLS LAST) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_public_views_idx" ON "products" USING btree ("stats_views" DESC NULLS LAST) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_public_published_idx" ON "products" USING btree ("published_at" DESC NULLS LAST) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_public_featured_idx" ON "products" USING btree ("featured","published_at" DESC NULLS LAST) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_seller_idx" ON "products" USING btree ("seller_id","created_at" DESC NULLS LAST) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search");--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_brand_trgm_idx" ON "products" USING gin ("brand" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "wishlist_items_user_product_key" ON "wishlist_items" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX "wishlist_items_user_idx" ON "wishlist_items" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wishlist_items_product_idx" ON "wishlist_items" USING btree ("product_id","restock_alert");--> statement-breakpoint
CREATE INDEX "conversations_buyer_idx" ON "conversations" USING btree ("buyer_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_seller_idx" ON "conversations" USING btree ("seller_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_thread_idx" ON "conversations" USING btree ("buyer_id","seller_id","product_id","order_id");--> statement-breakpoint
CREATE INDEX "conversations_order_idx" ON "conversations" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_reference_key" ON "disputes" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "disputes_order_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "disputes_state_idx" ON "disputes" USING btree ("state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_buyer_idx" ON "disputes" USING btree ("buyer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_seller_idx" ON "disputes" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "offers_conversation_idx" ON "offers" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "offers_buyer_product_idx" ON "offers" USING btree ("buyer_id","product_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_position_key" ON "order_items" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_title_trgm_idx" ON "order_items" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reference_key" ON "orders" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_escrow_reference_key" ON "orders" USING btree ("escrow_reference");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_seller_idx" ON "orders" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_checkout_idx" ON "orders" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "orders_payment_reference_idx" ON "orders" USING btree ("payment_reference");--> statement-breakpoint
CREATE INDEX "orders_status_ship_by_idx" ON "orders" USING btree ("status","ship_by");--> statement-breakpoint
CREATE INDEX "orders_escrow_status_idx" ON "orders" USING btree ("escrow_status","escrow_funded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_escrow_inspection_idx" ON "orders" USING btree ("escrow_phase","escrow_inspection_ends_at");--> statement-breakpoint
CREATE INDEX "orders_expires_at_idx" ON "orders" USING btree ("expires_at") WHERE status = 'awaiting-payment';--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_key" ON "reviews" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reviews_seller_idx" ON "reviews" USING btree ("seller_id","hidden","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_order_key" ON "earnings" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "earnings_seller_idx" ON "earnings" USING btree ("seller_id","status","released_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payment_orders_order_idx" ON "payment_orders" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_reference_key" ON "payment_refunds" USING btree ("refund_reference");--> statement-breakpoint
CREATE INDEX "payment_refunds_payment_idx" ON "payment_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_provider_id_idx" ON "payment_refunds" USING btree ("provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_one_per_order_key" ON "payment_refunds" USING btree ("payment_id","order_id") WHERE status <> 'failed' and order_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reference_key" ON "payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payments_provider_reference_idx" ON "payments" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "payments_buyer_idx" ON "payments" USING btree ("buyer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_checkout_idx" ON "payments" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "payments_status_created_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_unfulfilled_idx" ON "payments" USING btree ("paid_at") WHERE status = 'paid' and fulfilled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_accounts_user_fingerprint_key" ON "payout_accounts" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "payout_accounts_user_idx" ON "payout_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_reference_key" ON "payouts" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "payouts_seller_idx" ON "payouts" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_events_received_idx" ON "provider_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "verifications_user_idx" ON "verifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "verifications_status_idx" ON "verifications" USING btree ("status","submitted_at" DESC NULLS LAST);