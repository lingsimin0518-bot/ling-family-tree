package cn.lingshi.familytree.dto;

import cn.lingshi.familytree.entity.Person;
import java.time.LocalDate;
import java.time.LocalDateTime;

public record PersonResponse(
        Long id,
        Long familyId,
        String name,
        String gender,
        Integer generation,
        LocalDate birthDate,
        LocalDate deathDate,
        String biography,
        LocalDateTime createdAt,
        LocalDateTime updatedAt,
        Integer version
) {
    public static PersonResponse from(Person person) {
        return new PersonResponse(
                person.getId(), person.getFamilyId(), person.getName(), person.getGender(),
                person.getGeneration(), person.getBirthDate(), person.getDeathDate(),
                person.getBiography(), person.getCreatedAt(), person.getUpdatedAt(), person.getVersion()
        );
    }
}
