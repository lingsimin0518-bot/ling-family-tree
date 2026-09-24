CREATE TABLE IF NOT EXISTS family (
    id BIGINT NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS person (
    id BIGINT NOT NULL AUTO_INCREMENT,
    family_id BIGINT NOT NULL,
    name VARCHAR(80) NOT NULL,
    gender VARCHAR(30) NULL,
    generation INT NOT NULL,
    birth_date DATE NULL,
    death_date DATE NULL,
    biography TEXT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    INDEX idx_person_family_generation (family_id, generation),
    INDEX idx_person_family_name (family_id, name),
    CONSTRAINT fk_person_family FOREIGN KEY (family_id) REFERENCES family(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS relationship (
    id BIGINT NOT NULL AUTO_INCREMENT,
    family_id BIGINT NOT NULL,
    from_person_id BIGINT NOT NULL,
    to_person_id BIGINT NOT NULL,
    relationship_type VARCHAR(30) NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    INDEX idx_relationship_family_from (family_id, from_person_id),
    INDEX idx_relationship_family_to (family_id, to_person_id),
    CONSTRAINT fk_relationship_family FOREIGN KEY (family_id) REFERENCES family(id),
    CONSTRAINT fk_relationship_from_person FOREIGN KEY (from_person_id) REFERENCES person(id),
    CONSTRAINT fk_relationship_to_person FOREIGN KEY (to_person_id) REFERENCES person(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
