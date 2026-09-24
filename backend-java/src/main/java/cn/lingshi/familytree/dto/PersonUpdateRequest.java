package cn.lingshi.familytree.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import java.time.LocalDate;

public record PersonUpdateRequest(
        @NotNull @Positive Long familyId,
        @NotBlank String name,
        String gender,
        @NotNull @Positive Integer generation,
        LocalDate birthDate,
        LocalDate deathDate,
        String biography,
        @NotNull @Positive Integer version
) {
}
